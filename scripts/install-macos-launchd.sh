#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_TEMPLATE="$REPO_ROOT/launchd/com.openclaw.codex-imagegen-service.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/com.openclaw.codex-imagegen-service.plist"
TMP_PLIST="$(mktemp)"

if ! command -v node >/dev/null 2>&1; then
  echo "[codex-imagegen] node not found in PATH" >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "[codex-imagegen] codex CLI not found in PATH" >&2
  exit 1
fi

echo "[codex-imagegen] prerequisite reminder: this package requires a locally installed codex CLI plus a valid upstream Codex/GPT image-generation entitlement with available quota."

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p /tmp/codex-imagegen-service

sed "s|__REPO_ROOT__|$REPO_ROOT|g" "$PLIST_TEMPLATE" > "$TMP_PLIST"
mv "$TMP_PLIST" "$TARGET_PLIST"

launchctl bootout "gui/$UID" "$TARGET_PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$TARGET_PLIST"
launchctl kickstart -k "gui/$UID/com.openclaw.codex-imagegen-service"

sleep 1
HEALTH="$(curl -sS --max-time 5 http://127.0.0.1:4312/health || true)"
if [[ -z "$HEALTH" ]]; then
  echo "[codex-imagegen] service started but health check returned nothing" >&2
  exit 2
fi

echo "[codex-imagegen] installed LaunchAgent: $TARGET_PLIST"
echo "[codex-imagegen] repo root: $REPO_ROOT"
echo "[codex-imagegen] health: $HEALTH"
