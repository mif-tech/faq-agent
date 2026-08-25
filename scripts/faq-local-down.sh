#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_VARS_FILE="$PROJECT_ROOT/lambda/env-vars.local.faq.json"
compose_args=()

if (($# > 1)); then
  printf 'Usage: %s [-v|--volumes]\n' "$0" >&2
  exit 2
fi

case "${1:-}" in
  '')
    ;;
  -v|--volumes)
    compose_args+=(--volumes)
    ;;
  *)
    printf 'Usage: %s [-v|--volumes]\n' "$0" >&2
    exit 2
    ;;
esac

cd "$PROJECT_ROOT"
compose_status=0
docker compose down "${compose_args[@]}" || compose_status=$?

# faq-local-up.sh may copy ANTHROPIC_API_KEY into this SAM-only file. Always
# remove the exact project-local file, even if Docker/Compose shutdown fails.
if [[ -e "$ENV_VARS_FILE" || -L "$ENV_VARS_FILE" ]]; then
  if rm -f -- "$ENV_VARS_FILE"; then
    printf '[OK] Removed local SAM environment file: lambda/env-vars.local.faq.json\n'
  else
    printf '[ERROR] Could not remove local SAM environment file: %s\n' "$ENV_VARS_FILE" >&2
    exit 1
  fi
fi

if ((compose_status != 0)); then
  printf '[ERROR] docker compose down failed (exit %d); the local SAM environment file cleanup was still attempted.\n' "$compose_status" >&2
  exit "$compose_status"
fi

if ((${#compose_args[@]} > 0)); then
  printf '[OK] Local containers, network, and Compose-managed volumes were removed.\n'
else
  printf '[OK] Local containers and network were removed. Use -v to remove Compose-managed volumes too.\n'
fi
