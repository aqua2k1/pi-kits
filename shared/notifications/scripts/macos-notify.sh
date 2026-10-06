#!/bin/sh
set -eu

if ! command -v terminal-notifier >/dev/null 2>&1; then
  printf '%s\n' "terminal-notifier is required for macOS notifications" >&2
  exit 127
fi

title=${1:-Pi}
message=${2:-Task completed.}
group="pi-notification"

# Do not put shared state in /tmp: notifications and their lock are user-private.
umask 077
case ${HOME:-} in
  /*) state="$HOME/.pi-kits-notifications" ;;
  *) printf '%s\n' "An absolute HOME is required" >&2; exit 1 ;;
esac
if [ -L "$state" ]; then
  printf '%s\n' "Notification state must not be a symbolic link" >&2
  exit 1
fi
mkdir -m 700 "$state" 2>/dev/null || [ -d "$state" ]
chmod 700 "$state"

locked=0
generation=
cleanup() {
  if [ "$locked" = 1 ]; then
    rmdir "$state/lock"
    locked=0
  fi
  if [ -n "$generation" ]; then
    rm -rf "$generation"
  fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

acquire_lock() {
  attempts=0
  # mkdir is atomic on macOS too. Bound contention (including abandoned locks)
  # and fail closed; stealing a lock could race a still-running notifier.
  until mkdir "$state/lock" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 40 ]; then
      printf '%s\n' "Could not acquire notification lock" >&2
      return 1
    fi
    sleep 0.05 || return $?
  done
  locked=1
}
release_lock() {
  rmdir "$state/lock"
  locked=0
}

# Keep the unique directory alive until its timer finishes: no PID or timestamp
# reuse can make an older timer match a newer notification.
generation=$(mktemp -d "$state/generation.XXXXXXXX")
printf '%s\n' "$generation" > "$generation/token"
acquire_lock
# Prepare and publish before sending, still under the lock. A recording failure
# must never leave a newly delivered notification owned by the previous timer.
if [ -f "$state/current" ]; then
  cp "$state/current" "$generation/previous"
fi
mv -f "$generation/token" "$state/current"
if terminal-notifier \
  -title "$title" \
  -message "$message" \
  -group "$group"; then
  :
else
  status=$?
  # Restore the previous timer on delivery failure. If rollback itself fails,
  # the new token remains, safely preventing old timers from deleting anything.
  if [ -f "$generation/previous" ]; then
    mv -f "$generation/previous" "$state/current" || exit "$status"
  else
    rm -f "$state/current" || exit "$status"
  fi
  exit "$status"
fi
release_lock

(
  # The parent has released the lock; the worker owns only its own generation.
  trap cleanup 0
  trap 'exit 1' HUP INT TERM
  sleep 60 || exit $?
  acquire_lock || exit $?
  current=
  if [ -f "$state/current" ]; then
    IFS= read -r current < "$state/current" || exit 1
  fi
  if [ "$current" = "$generation" ]; then
    # Keep the comparison and external deletion inside the same critical section.
    if terminal-notifier -remove "$group"; then
      rm -f "$state/current"
    else
      exit $?
    fi
  fi
) </dev/null >/dev/null 2>&1 &
# Do not let the parent's EXIT trap remove the worker's unique generation.
generation=
