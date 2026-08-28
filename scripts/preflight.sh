#!/usr/bin/env bash

# Local FAQ prerequisites only. This script deliberately performs no network
# requests; it inspects commands, the local Docker daemon, and listening ports.
set -uo pipefail

NG_COUNT=0
WARN_COUNT=0

ok() {
  printf '[OK] %s\n' "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '[WARN] %s\n' "$1"
}

ng() {
  NG_COUNT=$((NG_COUNT + 1))
  printf '[NG] %s\n' "$1"
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

version_at_least() {
  local installed="$1"
  local required="$2"
  local index installed_part required_part
  local IFS=.
  local -a installed_parts required_parts

  read -r -a installed_parts <<< "$installed"
  read -r -a required_parts <<< "$required"
  for index in 0 1 2; do
    installed_part="${installed_parts[$index]:-0}"
    required_part="${required_parts[$index]:-0}"
    installed_part="${installed_part%%[^0-9]*}"
    required_part="${required_part%%[^0-9]*}"
    installed_part="${installed_part:-0}"
    required_part="${required_part:-0}"
    if ((10#$installed_part > 10#$required_part)); then
      return 0
    fi
    if ((10#$installed_part < 10#$required_part)); then
      return 1
    fi
  done
  return 0
}

check_docker() {
  local version compose_output compose_version

  if ! has_command docker; then
    ng 'docker が見つかりません（Docker Engine 24+ または Docker Desktop 4+ が必要です）'
    return
  fi

  if docker info >/dev/null 2>&1; then
    version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
    if [[ -n "$version" ]] && version_at_least "$version" '24.0.0'; then
      ok "Docker daemon: running (Engine $version)"
    elif [[ -n "$version" ]]; then
      ng "Docker Engine $version は未対応です（24.0.0 以上が必要です）"
    else
      ok 'Docker daemon: running'
    fi
  else
    ng 'Docker daemon に接続できません（Docker Desktop / Docker Engine を起動してください）'
  fi

  if compose_output="$(docker compose version 2>&1)"; then
    if [[ "$compose_output" =~ v?([0-9]+\.[0-9]+(\.[0-9]+)?) ]]; then
      compose_version="${BASH_REMATCH[1]}"
      if version_at_least "$compose_version" '2.0.0'; then
        ok "Docker Compose v2: $compose_version"
      else
        ng "Docker Compose $compose_version は未対応です（v2 が必要です）"
      fi
    else
      warn "Docker Compose のバージョンを判定できません: $compose_output"
    fi
  else
    ng 'docker compose v2 が利用できません'
  fi
}

check_sam() {
  local output version
  if ! has_command sam; then
    ng 'sam が見つかりません（AWS SAM CLI 1.100.0 以上が必要です）'
    return
  fi
  if ! output="$(sam --version 2>&1)"; then
    ng "sam --version に失敗しました: $output"
    return
  fi
  if [[ "$output" =~ ([0-9]+\.[0-9]+(\.[0-9]+)?) ]]; then
    version="${BASH_REMATCH[1]}"
    if version_at_least "$version" '1.100.0'; then
      ok "AWS SAM CLI: $version"
    else
      ng "AWS SAM CLI $version は未対応です（1.100.0 以上が必要です）"
    fi
  else
    warn "AWS SAM CLI のバージョンを判定できません: $output"
  fi
}

check_aws_cli() {
  local output major
  if ! has_command aws; then
    warn 'aws が見つかりません（ローカル FAQ の起動には不要です。AWS へデプロイする場合は AWS CLI v2 を導入してください）'
    return
  fi
  if ! output="$(aws --version 2>&1)"; then
    warn "aws --version に失敗しました（ローカル FAQ の起動は続行できます）: $output"
    return
  fi
  if [[ "$output" =~ aws-cli/([0-9]+)\. ]]; then
    major="${BASH_REMATCH[1]}"
    if ((major >= 2)); then
      ok "AWS CLI: $output"
    else
      warn "AWS CLI v$major はデプロイ用途では未対応です（ローカル FAQ の起動には不要です。デプロイには v2 が必要です）"
    fi
  else
    warn "AWS CLI のバージョンを判定できません: $output"
  fi
}

check_node_and_npm() {
  local node_version npm_version
  if ! has_command node; then
    ng 'node が見つかりません（Node.js 22 以上が必要です）'
  else
    node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
    if [[ -n "$node_version" ]] && version_at_least "$node_version" '22.0.0'; then
      ok "Node.js: $node_version"
    elif [[ -n "$node_version" ]]; then
      ng "Node.js $node_version は未対応です（22.0.0 以上が必要です）"
    else
      ng 'Node.js のバージョンを取得できません'
    fi
  fi

  if ! has_command npm; then
    ng 'npm が見つかりません'
  else
    npm_version="$(npm --version 2>/dev/null || true)"
    if [[ -n "$npm_version" ]]; then
      ok "npm: $npm_version"
    else
      ng 'npm --version に失敗しました'
    fi
  fi
}

check_port() {
  local port="$1"
  local listening=''

  if has_command lsof; then
    listening="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  elif has_command ss; then
    listening="$(ss -ltnH 2>/dev/null | grep -E "[[:space:]][^[:space:]]*:${port}[[:space:]]" || true)"
  elif has_command netstat; then
    listening="$(netstat -an 2>/dev/null | grep -Ei "[:.]${port}[[:space:]].*(LISTEN|LISTENING)" || true)"
  elif has_command powershell.exe; then
    if powershell.exe -NoProfile -NonInteractive -Command \
      "if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" \
      >/dev/null 2>&1; then
      listening="powershell:$port"
    fi
  else
    warn "port $port: 確認ツール (lsof/ss/netstat/PowerShell) がないためスキップしました"
    return
  fi

  if [[ -n "$listening" ]]; then
    # 自分の dynamodb-local コンテナが掴んでいる 8000 は再実行として正常（Ctrl+C で sam local だけ止めた後に
    # faq:local:up を再実行するケース。テーブル作成・seed は冪等なのでそのまま続行できる / レビュー指摘）
    if [[ "$port" == "8000" ]] && has_command docker && [[ -n "$(docker ps -q --filter name='^dynamodb-local$' --filter publish=8000 2>/dev/null)" ]]; then
      ok "port $port: in use by this project's dynamodb-local container (re-run is fine)"
      return
    fi
    ng "port $port は使用中です（既存プロセスを停止するか、ポート設定を見直してください）"
  else
    ok "port $port: available"
  fi
}

check_platform() {
  local machine kernel os autocrlf
  machine="$(uname -m 2>/dev/null || true)"
  kernel="$(uname -r 2>/dev/null || true)"
  os="$(uname -s 2>/dev/null || true)"

  case "$machine" in
    arm64|aarch64)
      if [[ "${DOCKER_DEFAULT_PLATFORM:-}" == 'linux/amd64' ]]; then
        ok 'Apple Silicon / ARM: DOCKER_DEFAULT_PLATFORM=linux/amd64'
      else
        warn 'Apple Silicon / ARM: SAM テンプレートは x86_64 です。イメージ不一致時は export DOCKER_DEFAULT_PLATFORM=linux/amd64 を設定してください'
      fi
      ;;
  esac

  if [[ "$kernel" =~ [Mm]icrosoft ]]; then
    if [[ "$kernel" =~ WSL2|wsl2 ]]; then
      ok 'Windows: WSL2 上で実行中'
    else
      warn 'Windows: WSL は検出しましたが WSL2 を確認できません。WSL2 上で実行してください'
    fi
  elif [[ "$os" =~ MINGW|MSYS|CYGWIN ]]; then
    warn 'Windows: Git Bash/MSYS ではなく WSL2 上で実行してください'
  fi

  if has_command git && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    autocrlf="$(git config --get core.autocrlf 2>/dev/null || true)"
    if [[ "${autocrlf,,}" == 'true' ]]; then
      warn 'git core.autocrlf=true です。shell script が CRLF なら dos2unix で LF に変換してください'
    else
      ok "git core.autocrlf: ${autocrlf:-unset}"
    fi
  fi
}

printf '%s\n' 'FAQ local preflight (外部ネットワーク接続なし)'
check_docker
check_sam
check_aws_cli
check_node_and_npm
check_port 3000
check_port 8000
check_platform

printf '\nSummary: %d NG, %d WARN\n' "$NG_COUNT" "$WARN_COUNT"
if ((NG_COUNT > 0)); then
  exit 1
fi
exit 0
