#!/bin/bash
# Sends a minimal request to the model from the instance, as the agent's user
# and with the same credentials dsh uses, to validate permissions and region.
# Usage: scripts/test-model.sh
. "$(dirname "$0")/common.sh"

instance_id=$(stack_output InstanceId)
provider=$(stack_output LlmProvider)

if [ "$provider" = "bedrock" ]; then
  model_id=$(stack_output BedrockModelId)
  echo "Probando $model_id en Bedrock desde $instance_id..."
  remote=$(cat <<EOF
set -e
exec 2>&1
[ -f /run/dsh-web/env ] || { echo "dsh-web todavía no arrancó (falta /run/dsh-web/env)"; exit 1; }
sudo -u dsh bash -c '. /run/dsh-web/env && aws bedrock-runtime converse \
  --model-id "$model_id" \
  --messages "[{\"role\":\"user\",\"content\":[{\"text\":\"Respondé solamente: OK\"}]}]" \
  --inference-config maxTokens=200 \
  --query "output.message.content[?text].text | [0]" --output text'
EOF
)
else
  echo "Probando la API de DeepSeek desde $instance_id..."
  remote=$(cat <<'EOF'
set -e
exec 2>&1
[ -f /run/dsh-web/env ] || { echo "dsh-web todavía no arrancó: ¿cargaste la API key con scripts/set-api-key.sh?"; exit 1; }
sudo -u dsh bash -c '. /run/dsh-web/env && curl -fsS https://api.deepseek.com/models \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" | jq -r ".data[].id"'
EOF
)
fi

if output=$(run_remote "$instance_id" "$remote"); then
  echo "$output"
  echo "✔ El modelo responde."
else
  echo "$output" >&2
  die "La prueba falló. Revisá: sudo journalctl -u dsh-web -n 50 (en la instancia)."
fi
