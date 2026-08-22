#!/usr/bin/env bash
set -euo pipefail
set +x

SOURCE="${BASH_SOURCE[0]}"
_seen=""
_count=0
while [ -L "$SOURCE" ]; do
  _count=$((_count+1))
  if [ "$_count" -gt 40 ]; then
    echo "preflight: too many symlink levels (possible cycle) for $SOURCE" >&2
    exit 1
  fi
  case ":$_seen:" in
    *":$SOURCE:"*)
      echo "preflight: cyclic symlink: $SOURCE" >&2
      exit 1
      ;;
  esac
  _seen="${_seen}:$SOURCE"
  LINK_TARGET="$(readlink "$SOURCE" 2>/dev/null)" || {
    echo "preflight: broken symlink: $SOURCE" >&2
    exit 1
  }
  if [ -z "$LINK_TARGET" ]; then
    echo "preflight: broken symlink: $SOURCE" >&2
    exit 1
  fi
  if [[ "$LINK_TARGET" != /* ]]; then
    SOURCE="$(dirname "$SOURCE")/$LINK_TARGET"
  else
    SOURCE="$LINK_TARGET"
  fi
  if [ ! -e "$SOURCE" ] && [ ! -L "$SOURCE" ]; then
    echo "preflight: broken symlink target: $SOURCE" >&2
    exit 1
  fi
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
HELPER="${SCRIPT_DIR}/rotate-opencode-go-key-helper.mjs"

DSH_URL="${DSH_URL:-http://127.0.0.1:3080}"
PI_AUTH="${PI_AUTH:-$HOME/.pi/agent/auth.json}"
OPENCODE_AUTH="${OPENCODE_AUTH:-$HOME/.local/share/opencode/auth.json}"
CODEX_SECRET="${CODEX_SECRET:-$HOME/.codex/codex-router/opencode-go-api-key.secret}"

umask 077

cleanup() {
  stty echo < /dev/tty 2>/dev/null || true
  # scrub secrets from shell variables
  NEWKEY=""; KEY1=""; KEY2=""; HELPER_EXIT=""
  unset NEWKEY KEY1 KEY2 HELPER_EXIT 2>/dev/null || true
  set +x
}
trap cleanup INT TERM HUP EXIT

if [ ! -f "$HELPER" ]; then
  echo "preflight: helper missing: $HELPER" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "preflight: node not found" >&2
  exit 1
fi

if [ ! -e /dev/tty ]; then
  echo "no /dev/tty available; this script requires interactive hidden input" >&2
  exit 1
fi
if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
  echo "/dev/tty not readable/writable" >&2
  exit 1
fi

printf "Enter new OpenCode Go API key: " >&2
if command -v stty >/dev/null 2>&1; then
  stty -echo < /dev/tty 2>/dev/null || true
fi
IFS= read -r KEY1 < /dev/tty || { stty echo < /dev/tty 2>/dev/null || true; printf "\n" >&2; echo "read failed" >&2; exit 1; }
if command -v stty >/dev/null 2>&1; then
  stty echo < /dev/tty 2>/dev/null || true
fi
printf "\n" >&2

printf "Confirm key: " >&2
if command -v stty >/dev/null 2>&1; then
  stty -echo < /dev/tty 2>/dev/null || true
fi
IFS= read -r KEY2 < /dev/tty || { stty echo < /dev/tty 2>/dev/null || true; printf "\n" >&2; echo "read failed" >&2; exit 1; }
if command -v stty >/dev/null 2>&1; then
  stty echo < /dev/tty 2>/dev/null || true
fi
printf "\n" >&2

if [ "$KEY1" != "$KEY2" ]; then
  echo "keys do not match; aborted" >&2
  KEY1=""; KEY2=""; unset KEY1 KEY2
  exit 1
fi
NEWKEY="$KEY1"
unset KEY1 KEY2

if [ -z "$NEWKEY" ]; then echo "validation failed: empty key" >&2; exit 1; fi
if printf "%s" "$NEWKEY" | grep -q '[[:space:]]'; then
  echo "validation failed: key contains whitespace" >&2
  NEWKEY=""; unset NEWKEY
  exit 1
fi
PREFIX="$(printf '%s' 's' ; printf '%s' 'k' ; printf '%s' '-')"
case "$NEWKEY" in
  "$PREFIX"*) ;;
  *) echo "validation failed: key must start with ${PREFIX} and be plausible length" >&2; NEWKEY=""; unset NEWKEY; exit 1;;
esac
if [ "${#NEWKEY}" -lt 20 ]; then
  echo "validation failed: key too short" >&2
  NEWKEY=""; unset NEWKEY
  exit 1
fi
# ensure at least 15 chars after prefix
SUFFIX="${NEWKEY#"$PREFIX"}"
if [ "${#SUFFIX}" -lt 15 ]; then
  echo "validation failed: key too short after prefix" >&2
  NEWKEY=""; unset NEWKEY
  exit 1
fi

HELPER_EXIT=0
set +e
printf '%s' "$NEWKEY" | node "$HELPER" --pi-auth "$PI_AUTH" --opencode-auth "$OPENCODE_AUTH" --codex-secret "$CODEX_SECRET" --dsh-url "$DSH_URL"
HELPER_EXIT=$?
set -e

NEWKEY=""; unset NEWKEY

if [ $HELPER_EXIT -ne 0 ]; then
  exit $HELPER_EXIT
fi

echo "rotation complete" >&2
exit 0
