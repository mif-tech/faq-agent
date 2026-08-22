#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
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
docker compose down "${compose_args[@]}"

if ((${#compose_args[@]} > 0)); then
  printf '[OK] Local containers, network, and Compose-managed volumes were removed.\n'
else
  printf '[OK] Local containers and network were removed. Use -v to remove Compose-managed volumes too.\n'
fi
