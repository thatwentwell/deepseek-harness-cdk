# Provisions a DeepSeek Harness host on Amazon Linux 2023.
# Expects SECRET_ARN, DSH_VERSION, NODE_MAJOR, WEB_PORT and BLOCK_IMDS to be
# exported by the CDK-generated user data that prepends this file.
set -euo pipefail
exec > >(tee -a /var/log/dsh-bootstrap.log) 2>&1

# cfn-signal (used by the exit trap) and the toolchain the agent and native
# npm modules need.
dnf install -y aws-cfn-bootstrap git tar xz gcc-c++ make python3 iptables-nft jq

# --- Node.js (official tarball, checksum-verified) -------------------------
case "$(uname -m)" in
  aarch64) NODE_ARCH=arm64 ;;
  x86_64)  NODE_ARCH=x64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac
NODE_DIST="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
workdir=$(mktemp -d)
curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$workdir/SHASUMS256.txt"
NODE_TARBALL=$(grep -oE "node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz" "$workdir/SHASUMS256.txt" | head -1)
curl -fsSL "$NODE_DIST/$NODE_TARBALL" -o "$workdir/$NODE_TARBALL"
(cd "$workdir" && grep " $NODE_TARBALL\$" SHASUMS256.txt | sha256sum -c -)
mkdir -p /opt/node
tar -xJf "$workdir/$NODE_TARBALL" -C /opt/node --strip-components=1
rm -rf "$workdir"
echo 'export PATH=/opt/node/bin:$PATH' > /etc/profile.d/node.sh
export PATH=/opt/node/bin:$PATH

# --- DeepSeek Harness -------------------------------------------------------
npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" pnpm
dsh --version

# Dedicated unprivileged user; the agent runs shell commands as this user.
id dsh >/dev/null 2>&1 || useradd --create-home --shell /bin/bash dsh
install -d -o dsh -g dsh -m 0750 /home/dsh/workspace

cat > /etc/dsh-web.conf <<EOF
SECRET_ARN='${SECRET_ARN}'
WEB_PORT='${WEB_PORT}'
BLOCK_IMDS='${BLOCK_IMDS}'
EOF
chmod 0644 /etc/dsh-web.conf

# Runs as root before every start: fetches the API key and (optionally)
# firewalls the instance metadata service off from the agent's user.
cat > /usr/local/sbin/dsh-web-prestart <<'EOF'
#!/bin/bash
set -euo pipefail
. /etc/dsh-web.conf

if [ "$BLOCK_IMDS" = "true" ]; then
  uid=$(id -u dsh)
  iptables -C OUTPUT -d 169.254.169.254 -m owner --uid-owner "$uid" -j REJECT 2>/dev/null \
    || iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner "$uid" -j REJECT
fi

imds_token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
region=$(curl -fsS -H "X-aws-ec2-metadata-token: $imds_token" \
  http://169.254.169.254/latest/meta-data/placement/region)
key=$(aws secretsmanager get-secret-value --region "$region" --secret-id "$SECRET_ARN" \
  --query SecretString --output text)

if [ -z "$key" ] || [ "$key" = "REPLACE_ME" ]; then
  echo "DEEPSEEK_API_KEY not set yet: update secret $SECRET_ARN (scripts/set-api-key.sh)" >&2
  exit 1
fi

umask 077
printf 'export DEEPSEEK_API_KEY=%q\n' "$key" > /run/dsh-web/env
chown dsh:dsh /run/dsh-web/env
EOF
chmod 0750 /usr/local/sbin/dsh-web-prestart

cat > /usr/local/bin/dsh-web-start <<'EOF'
#!/bin/bash
set -euo pipefail
. /etc/dsh-web.conf
. /run/dsh-web/env
cd /home/dsh/workspace
# Loopback only: dsh refuses 0.0.0.0, and access goes through SSM port forwarding.
exec dsh --profile web --no-open --host 127.0.0.1 --port "$WEB_PORT"
EOF
chmod 0755 /usr/local/bin/dsh-web-start

cat > /etc/systemd/system/dsh-web.service <<'EOF'
[Unit]
Description=DeepSeek Harness Web UI
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=dsh
Group=dsh
Environment=HOME=/home/dsh
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
RuntimeDirectory=dsh-web
RuntimeDirectoryMode=0700
ExecStartPre=+/usr/local/sbin/dsh-web-prestart
ExecStart=/usr/local/bin/dsh-web-start
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
# Enabled now; it keeps retrying until the API key secret is filled in.
systemctl enable --now dsh-web.service || true
echo "bootstrap complete"
