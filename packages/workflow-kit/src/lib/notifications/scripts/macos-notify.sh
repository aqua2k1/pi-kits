#!/bin/sh
set -eu

if ! command -v terminal-notifier >/dev/null 2>&1; then
  printf '%s\n' "terminal-notifier is required for macOS notifications" >&2
  exit 127
fi

title=${1:-Pi}
message=${2:-Task completed.}
group="pi-notification"

if terminal-notifier \
  -title "$title" \
  -message "$message" \
  -group "$group"; then
  (
    sleep 60
    terminal-notifier -remove "$group"
  ) >/dev/null 2>&1 &
else
  exit $?
fi
