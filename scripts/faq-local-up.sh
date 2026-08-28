#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LAMBDA_DIR="$PROJECT_ROOT/lambda"
ENV_VARS_FILE="$LAMBDA_DIR/env-vars.local.faq.json"
FAQ_TABLES='Settings,KnowledgeEntries,FaqQaLogs'
LITE_INIT_SCRIPT="$PROJECT_ROOT/scripts/dynamodb-init-faq.ts"

bash "$SCRIPT_DIR/preflight.sh"

cd "$PROJECT_ROOT"
printf '\n[INFO] Starting DynamoDB Local...\n'
docker compose up -d dynamodb-local

printf '[INFO] Waiting for DynamoDB Local health check (up to 60 seconds)'
deadline=$((SECONDS + 60))
health='starting'
while ((SECONDS < deadline)); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' dynamodb-local 2>/dev/null || true)"
  if [[ "$health" == 'healthy' ]]; then
    printf ' ready\n'
    break
  fi
  # Fallback: probe from the host (the image may lack curl for the in-container healthcheck).
  # DynamoDB Local answers any HTTP request once the listener is up (a 4xx is still "ready").
  if node -e "fetch('http://localhost:8000/').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
    health='healthy'
    printf ' ready (host probe)\n'
    break
  fi
  printf '.'
  sleep 2
done

if [[ "$health" != 'healthy' ]]; then
  printf '\n[ERROR] DynamoDB Local did not become healthy within 60 seconds (status: %s).\n' "${health:-unknown}" >&2
  docker compose logs --tail 100 dynamodb-local >&2 || true
  exit 1
fi

printf '[INFO] Creating the three FAQ tables (existing tables are skipped)...\n'
if [[ -f "$LITE_INIT_SCRIPT" ]]; then
  AWS_ACCESS_KEY_ID=local \
  AWS_SECRET_ACCESS_KEY=local \
  AWS_REGION=us-west-2 \
  AWS_DEFAULT_REGION=us-west-2 \
  AWS_EC2_METADATA_DISABLED=true \
  DYNAMODB_ENDPOINT=http://localhost:8000 \
  DYNAMODB_TABLE_PREFIX=dev \
    npx tsx scripts/dynamodb-init-faq.ts
else
  AWS_ACCESS_KEY_ID=local \
  AWS_SECRET_ACCESS_KEY=local \
  AWS_REGION=us-west-2 \
  AWS_DEFAULT_REGION=us-west-2 \
  AWS_EC2_METADATA_DISABLED=true \
  DYNAMODB_ENDPOINT=http://localhost:8000 \
  DYNAMODB_TABLE_PREFIX=dev \
  SKIP_SEED=true \
    npx tsx scripts/dynamodb-init.ts --only "$FAQ_TABLES"
fi

printf '[INFO] Seeding the sample FAQ knowledge and settings...\n'
npx tsx scripts/faq-local-seed.ts

printf '[INFO] Building the SAM application...\n'
(cd "$LAMBDA_DIR" && sam build)

printf '[INFO] Writing %s...\n' "$ENV_VARS_FILE"
ENV_VARS_FILE="$ENV_VARS_FILE" node <<'NODE'
const fs = require('node:fs');

const faqEnvironment = {
  FAQ_PORTS_PROFILE: 'free',
  DYNAMODB_ENDPOINT: 'http://dynamodb-local:8000',
  DYNAMODB_TABLE_PREFIX: 'dev',
  FAQ_TABLE_NAME_PREFIX: 'dev',
  FAQ_SETTINGS_TABLE_NAME: 'dev-Settings',
  FAQ_AGENT_CONFIG_TABLE_NAME: 'dev-AgentConfig',
  FAQ_KNOWLEDGE_ENTRIES_TABLE_NAME: 'dev-KnowledgeEntries',
  FAQ_QA_LOGS_TABLE_NAME: 'dev-FaqQaLogs',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  AWS_REGION: 'us-west-2',
  FAQ_CORS_ORIGIN: '*',
};

if (process.env.ANTHROPIC_API_KEY) {
  faqEnvironment.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
}

const envVarsFile = process.env.ENV_VARS_FILE;
fs.writeFileSync(
  envVarsFile,
  `${JSON.stringify({ FaqChatFunction: faqEnvironment }, null, 2)}\n`,
  { mode: 0o600 }
);
fs.chmodSync(envVarsFile, 0o600);
NODE

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  printf '[INFO] ANTHROPIC_API_KEY: host value will be forwarded to FaqChatFunction.\n'
else
  printf '[INFO] ANTHROPIC_API_KEY: unset; using the grounded keyword demo (no AI API call).\n'
fi

printf '\n[INFO] Starting FAQ API on http://localhost:3000 (Ctrl+C to stop).\n'
printf '%s\n' '[INFO] After the API is ready, run this in another terminal:'
printf '%s\n\n' "curl -s -X POST http://localhost:3000/faq-chat -H 'Content-Type: application/json' -d '{\"messages\":[{\"role\":\"user\",\"content\":\"営業時間を教えてください\"}]}'"

cd "$LAMBDA_DIR"
sam_parameters=(
  'Environment=dev'
  'DynamoDBEndpoint=http://dynamodb-local:8000'
  'FaqPortsProfile=free'
  'FaqChatCorsOrigin=*'
)
if [[ ! -f "$LITE_INIT_SCRIPT" ]]; then
  sam_parameters+=(
    'BackendType=dynamodb'
    'InternalApiKey=local-dev-internal-key'
    'KbIngestApiKey=local-dev-kb-ingest-key'
  )
fi
sam local start-api \
  --docker-network lambda-local \
  --env-vars env-vars.local.faq.json \
  --port 3000 \
  --config-env local \
  --parameter-overrides "${sam_parameters[@]}"
