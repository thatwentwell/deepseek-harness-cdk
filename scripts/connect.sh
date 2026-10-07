#!/bin/bash
# Opens an SSM port-forwarding tunnel to the Web UI and prints the
# authenticated URL (it carries the per-process token dsh prints at startup).
# Requires the AWS CLI Session Manager plugin.
. "$(dirname "$0")/common.sh"

command -v session-manager-plugin >/dev/null || {
  echo "Install the Session Manager plugin first:" >&2
  echo "  https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html" >&2
  exit 1
}

instance_id=$(stack_output InstanceId)
port=$(stack_output WebPort)

url=$(run_remote "$instance_id" \
  "journalctl -u dsh-web --no-pager -o cat -n 500 | sed 's/\x1b\[[0-9;]*m//g' | grep 'dsh web:' | tail -1 | grep -oE 'https?://[^ ]+'" \
  || true)

if [ -z "$url" ]; then
  echo "No startup URL found. Service status:" >&2
  run_remote "$instance_id" "systemctl status dsh-web --no-pager -n 20" >&2 || true
  exit 1
fi

echo
echo "Open this URL once the tunnel is up (Ctrl+C to close the tunnel):"
echo "  $url"
echo

aws ssm start-session --target "$instance_id" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=$port,localPortNumber=$port"
