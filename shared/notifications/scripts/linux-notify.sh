#!/bin/sh
set -eu

if ! command -v notify-send >/dev/null 2>&1; then
  printf '%s\n' "notify-send is required for Linux notifications" >&2
  exit 127
fi

title=${1:-Pi}
message=${2:-Task completed.}

state_root=${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}
state_file="$state_root/pi-notification.id"
replace_id=0
if [ -r "$state_file" ]; then
  replace_id=$(cat "$state_file")
fi

if notification_id=$(notify-send \
  --app-name=Pi \
  --expire-time=60000 \
  --replace-id="$replace_id" \
  --print-id \
  -- "$title" "$message"); then
  case "$notification_id" in
    ""|*[!0-9]*) rm -f "$state_file" ;;
    *) printf '%s\n' "$notification_id" >"$state_file" ;;
  esac
else
  exit $?
fi
