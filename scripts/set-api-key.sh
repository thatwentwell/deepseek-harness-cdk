#!/bin/bash
# Stores DEEPSEEK_API_KEY in the stack's secret and restarts the Web UI.
# Usage: scripts/set-api-key.sh            (prompts for the key)
#        DEEPSEEK_API_KEY=sk-... scripts/set-api-key.sh
. "$(dirname "$0")/common.sh"

key="${DEEPSEEK_API_KEY:-}"
if [ -z "$key" ]; then
  read -rsp "DeepSeek API key: " key
  echo
fi
[ -n "$key" ] || { echo "empty key" >&2; exit 1; }

secret_arn=$(stack_output ApiKeySecretArn)
instance_id=$(stack_output InstanceId)

aws secretsmanager put-secret-value --secret-id "$secret_arn" --secret-string "$key" >/dev/null
echo "Secret updated. Restarting dsh-web on $instance_id..."
run_remote "$instance_id" "systemctl restart dsh-web && sleep 5 && systemctl is-active dsh-web"
