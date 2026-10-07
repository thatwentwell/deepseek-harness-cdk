# Provisions a DeepSeek Harness host on Amazon Linux 2023.
# Expects LLM_PROVIDER, SECRET_ARN, BEDROCK_* , DSH_VERSION, NODE_MAJOR,
# WEB_PORT and BLOCK_IMDS to be exported by the CDK-generated user data that
# prepends this file.
set -euo pipefail
exec > >(tee -a /var/log/dsh-bootstrap.log) 2>&1

# cfn-signal (used by the exit trap) and the toolchain the agent and native
# npm modules need.
dnf install -y aws-cfn-bootstrap git tar xz gcc-c++ make python3 iptables-nft jq
# The IMDS block below depends on it: fail the deploy now, not at service start.
command -v iptables >/dev/null || command -v iptables-nft >/dev/null || { echo "iptables not installed"; exit 1; }

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

imds_token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
REGION=$(curl -fsS -H "X-aws-ec2-metadata-token: $imds_token" \
  http://169.254.169.254/latest/meta-data/placement/region)

cat > /etc/dsh-web.conf <<EOF
LLM_PROVIDER='${LLM_PROVIDER}'
REGION='${REGION}'
SECRET_ARN='${SECRET_ARN}'
BEDROCK_ROLE_ARN='${BEDROCK_ROLE_ARN}'
WEB_PORT='${WEB_PORT}'
BLOCK_IMDS='${BLOCK_IMDS}'
EOF
chmod 0644 /etc/dsh-web.conf

if [ "$LLM_PROVIDER" = "bedrock" ]; then
  # --- Bedrock credentials ----------------------------------------------------
  # Root assumes the Bedrock-only role with the instance role and drops the
  # temporary credentials where the agent's user can read them. The SDK gets
  # them through credential_process, which it re-runs whenever they expire;
  # a timer keeps the file at least 40 minutes away from expiring.
  install -d -o root -g dsh -m 0750 /var/lib/dsh-bedrock /etc/dsh-web

  cat > /usr/local/sbin/dsh-bedrock-credentials <<'EOF'
#!/bin/bash
set -euo pipefail
. /etc/dsh-web.conf
creds=$(aws sts assume-role --region "$REGION" --role-arn "$BEDROCK_ROLE_ARN" \
  --role-session-name dsh-agent --duration-seconds 3600 --query Credentials --output json)
tmp=$(mktemp /var/lib/dsh-bedrock/credentials.XXXXXX)
jq '{Version: 1, AccessKeyId, SecretAccessKey, SessionToken, Expiration}' <<<"$creds" > "$tmp"
chgrp dsh "$tmp"
chmod 0640 "$tmp"
mv -f "$tmp" /var/lib/dsh-bedrock/credentials.json
EOF
  chmod 0750 /usr/local/sbin/dsh-bedrock-credentials

  cat > /usr/local/bin/dsh-bedrock-credential-process <<'EOF'
#!/bin/sh
exec cat /var/lib/dsh-bedrock/credentials.json
EOF
  chmod 0755 /usr/local/bin/dsh-bedrock-credential-process

  cat > /etc/dsh-web/aws-config <<EOF
[profile bedrock]
region = ${REGION}
credential_process = /usr/local/bin/dsh-bedrock-credential-process
EOF
  chgrp dsh /etc/dsh-web/aws-config
  chmod 0640 /etc/dsh-web/aws-config

  cat > /etc/systemd/system/dsh-bedrock-credentials.service <<'EOF'
[Unit]
Description=Refresh DeepSeek Harness Bedrock credentials
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/dsh-bedrock-credentials
EOF

  cat > /etc/systemd/system/dsh-bedrock-credentials.timer <<'EOF'
[Unit]
Description=Refresh DeepSeek Harness Bedrock credentials every 20 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=20min

[Install]
WantedBy=timers.target
EOF

  # --- dsh: Bedrock route and default model ----------------------------------
  # The home-level patch applies over the Web profile. Values here are managed
  # by deploy.config.json, so the Web UI cannot override them.
  install -d -o dsh -g dsh -m 0700 /home/dsh/.dsh
  cat > /home/dsh/.dsh/cordis.patch.yml <<EOF
# Managed by the DeepSeek Harness CDK app (deploy.config.json). Bedrock caps
# DeepSeek output at ${BEDROCK_MAX_TOKENS} tokens, below the pi-ai catalog value.
- id: llm-pi-ai
  config:
    providers:
      amazon-bedrock:
        displayName: Amazon Bedrock
        # Required for models outside the pi-ai catalog, like an inference profile ARN.
        baseURL: https://bedrock-runtime.${REGION}.amazonaws.com
        models:
          - id: '${BEDROCK_MODEL_ID}'
            name: '${BEDROCK_MODEL_NAME}'
            contextWindow: ${BEDROCK_CONTEXT_WINDOW}
            maxTokens: ${BEDROCK_MAX_TOKENS}
            input: [text]

- id: agent-default-model
  config:
    provider: amazon-bedrock
    model: '${BEDROCK_MODEL_ID}'
EOF
  chown dsh:dsh /home/dsh/.dsh/cordis.patch.yml
fi

# Runs as root before every start: prepares the model credentials and
# (optionally) firewalls the instance metadata service off from the agent.
cat > /usr/local/sbin/dsh-web-prestart <<'EOF'
#!/bin/bash
set -euo pipefail
# The unit's PATH is the agent's, without the sbin directories root tools live in.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
. /etc/dsh-web.conf

if [ "$BLOCK_IMDS" = "true" ]; then
  ipt=$(command -v iptables || command -v iptables-nft)
  uid=$(id -u dsh)
  "$ipt" -C OUTPUT -d 169.254.169.254 -m owner --uid-owner "$uid" -j REJECT 2>/dev/null \
    || "$ipt" -I OUTPUT -d 169.254.169.254 -m owner --uid-owner "$uid" -j REJECT
fi

umask 077
if [ "$LLM_PROVIDER" = "bedrock" ]; then
  /usr/local/sbin/dsh-bedrock-credentials
  cat > /run/dsh-web/env <<ENV
export AWS_PROFILE=bedrock
export AWS_CONFIG_FILE=/etc/dsh-web/aws-config
export AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_REGION=$REGION
export AWS_DEFAULT_REGION=$REGION
export AWS_EC2_METADATA_DISABLED=true
ENV
else
  key=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ARN" \
    --query SecretString --output text)
  if [ -z "$key" ] || [ "$key" = "REPLACE_ME" ]; then
    echo "DEEPSEEK_API_KEY not set yet: update secret $SECRET_ARN (scripts/set-api-key.sh)" >&2
    exit 1
  fi
  printf 'export DEEPSEEK_API_KEY=%q\n' "$key" > /run/dsh-web/env
fi
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
if [ "$LLM_PROVIDER" = "bedrock" ]; then
  systemctl enable --now dsh-bedrock-credentials.timer
  # Fail provisioning (and the deploy) if the Bedrock role cannot be assumed.
  # Retries cover IAM propagation right after the stack creates the roles.
  for attempt in $(seq 1 12); do
    /usr/local/sbin/dsh-bedrock-credentials && break
    [ "$attempt" -lt 12 ] || { echo "cannot assume $BEDROCK_ROLE_ARN"; exit 1; }
    sleep 10
  done
fi
# With deepseek-api it keeps retrying until the API key secret is filled in.
systemctl enable --now dsh-web.service || true
echo "bootstrap complete"
