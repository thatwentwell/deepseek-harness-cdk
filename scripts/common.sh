# Shared helpers for the scripts in this directory. Source, don't execute.
set -euo pipefail

CONFIG_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy.config.json"

die() { echo "✖ $*" >&2; exit 1; }

command -v jq >/dev/null || die "Falta jq (sudo apt install jq / brew install jq)."
command -v aws >/dev/null || die "Falta la AWS CLI v2."

# The scripts only make sense against a deployed stack, so the config that
# `npm run deploy` writes must exist and name the region and stack.
[ -f "$CONFIG_FILE" ] || die "No existe $CONFIG_FILE.
  Ejecutá \"npm run deploy\" primero (o copiá deploy.config.json.example y desplegá)."
jq empty "$CONFIG_FILE" 2>/dev/null || die "$CONFIG_FILE no es JSON válido."

config_value() { jq -r --arg k "$1" '.[$k] // empty | tostring' "$CONFIG_FILE"; }

missing=()
for key in region stackName; do
  [ -n "$(config_value "$key")" ] || missing+=("$key")
done
[ ${#missing[@]} -eq 0 ] || die "Faltan parámetros en $CONFIG_FILE: ${missing[*]}"

export AWS_REGION AWS_DEFAULT_REGION STACK_NAME
AWS_REGION="$(config_value region)"
AWS_DEFAULT_REGION="$AWS_REGION"
STACK_NAME="$(config_value stackName)"

stack_output() {
  local value
  value=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null) \
    || die "No se encontró el stack \"$STACK_NAME\" en $AWS_REGION. ¿Terminó \"npm run deploy\"?"
  [ -n "$value" ] && [ "$value" != "None" ] || die "El stack \"$STACK_NAME\" no tiene el output $1."
  echo "$value"
}

# Runs a shell snippet on the instance as root via SSM and prints its stdout.
run_remote() {
  local instance_id="$1" script="$2" command_id status
  command_id=$(aws ssm send-command --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript \
    --parameters "$(jq -n --arg c "$script" '{commands: [$c]}')" \
    --query Command.CommandId --output text)
  for _ in $(seq 1 30); do
    sleep 2
    status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance_id" \
      --query Status --output text 2>/dev/null || echo Pending)
    case "$status" in
      Pending|InProgress|Delayed) continue ;;
      *) break ;;
    esac
  done
  aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance_id" \
    --query StandardOutputContent --output text
  [ "$status" = "Success" ]
}
