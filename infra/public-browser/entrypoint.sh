#!/bin/sh
set -eu

# A control token is deliberately required even though the Node-side control
# bridge has not yet been wired.  Refuse a public browser that would expose a
# broadly usable debugging endpoint by accident.
: "${PUBLIC_BROWSER_CONTROL_TOKEN:?PUBLIC_BROWSER_CONTROL_TOKEN is required}"

# Playwright's pinned Linux browser archive changed from chrome-linux to
# chrome-linux64. Accept both layouts so the explicit image pin, rather than
# an incidental archive-directory name, defines the browser boundary.
chromium="$(find /ms-playwright -type f \
  \( -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux/chrome' \) \
  -print -quit)"
if [ -z "$chromium" ]; then
  echo 'Playwright Chromium executable was not found in the pinned image' >&2
  exit 78
fi

# Chromium has no provider configuration or host mount. Docker supplies
# ordinary outbound networking for the operator-selected destination.
exec "$chromium" \
  --headless=new \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chromium-profile \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-quic \
  "$@"
