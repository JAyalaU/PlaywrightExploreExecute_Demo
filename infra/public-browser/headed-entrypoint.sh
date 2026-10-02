#!/bin/sh
set -eu

: "${PUBLIC_BROWSER_CONTROL_TOKEN:?PUBLIC_BROWSER_CONTROL_TOKEN is required}"

chromium="$(find /ms-playwright -type f \
  \( -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux/chrome' \) \
  -print -quit)"
if [ -z "$chromium" ]; then
  echo 'Playwright Chromium executable was not found in the pinned headed image' >&2
  exit 78
fi

display_pid=
rfb_pid=
chromium_pid=
cleanup() {
  status=$?
  trap - EXIT INT TERM
  for pid in "$chromium_pid" "$rfb_pid" "$display_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$chromium_pid" "$rfb_pid" "$display_pid"; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
  done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The X server accepts local clients only. Its socket and all browser state are
# inside the container's disposable /tmp filesystem.
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac >/dev/null 2>&1 &
display_pid=$!
ready=0
for attempt in $(seq 1 100); do
  if [ -S /tmp/.X11-unix/X99 ]; then ready=1; break; fi
  if ! kill -0 "$display_pid" 2>/dev/null; then break; fi
  sleep 0.05
done
if [ "$ready" -ne 1 ]; then
  echo 'Headed display failed to start' >&2
  exit 78
fi

# x11vnc enforces view-only at the RFB server. Clipboard/selection transfer is
# disabled independently of the later noVNC client UI. No VNC/TCP connection
# can arrive except from container loopback; no Docker port is published.
x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -nopw -forever -shared \
  -viewonly -noclipboard -nosel -noxdamage -quiet >/dev/null 2>&1 &
rfb_pid=$!
ready=0
for attempt in $(seq 1 100); do
  if grep -Eq '0100007F:170C[[:space:]]+00000000:0000[[:space:]]+0A' /proc/net/tcp; then ready=1; break; fi
  if ! kill -0 "$rfb_pid" 2>/dev/null; then break; fi
  sleep 0.05
done
if [ "$ready" -ne 1 ]; then
  echo 'View-only RFB service failed to bind container loopback' >&2
  exit 78
fi

# This is the same Chromium used by Playwright/CDP. The approved headless
# profile path remains on entrypoint.sh and is not changed by this variant.
"$chromium" \
  --no-sandbox \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chromium-profile \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-quic \
  "$@" &
chromium_pid=$!
set +e
wait "$chromium_pid"
status=$?
set -e
exit "$status"
