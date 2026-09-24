#!/bin/sh
# Install the latest ccx release.
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/ccx/main/scripts/install.sh | sh
#
# Add the resident agent (ccx-agent) as a user service with --with-agent:
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/ccx/main/scripts/install.sh | sh -s -- --with-agent
#
# Override the destination with CCX_INSTALL_DIR (default: ~/.local/bin).
# Pin a version with CCX_VERSION (default: latest).
# CCX_WITH_AGENT=1 is the same as --with-agent.

set -eu

REPO="TakashiAihara/ccx"
DEST="${CCX_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CCX_VERSION:-latest}"
# Where releases are downloaded from. Only the tests point it elsewhere.
BASE="${CCX_DOWNLOAD_URL:-https://github.com/${REPO}/releases}"
WITH_AGENT="${CCX_WITH_AGENT:-0}"

for a in "$@"; do
  case "$a" in
    --with-agent) WITH_AGENT=1 ;;
    *) echo "ccx: unknown option: $a" >&2; exit 2 ;;
  esac
done

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) echo "ccx: unsupported OS: $os" >&2; exit 1 ;;
esac

case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "ccx: unsupported architecture: $arch" >&2; exit 1 ;;
esac

# fetch <asset> <destination>: download one asset of the release to a file.
fetch() {
  if [ "$VERSION" = "latest" ]; then
    url="${BASE}/latest/download/$1"
  else
    url="${BASE}/download/${VERSION}/$1"
  fi
  echo "ccx: downloading $1 (${VERSION})"
  # Next to the destination, so the final mv is a rename: replacing a running
  # ccx-agent by copying over it fails with "Text file busy".
  tmp="$2.download.$$"
  if ! curl -fsSL "$url" -o "$tmp"; then
    rm -f "$tmp"
    echo "ccx: no file at $url" >&2
    echo "ccx: check the available releases: https://github.com/${REPO}/releases" >&2
    exit 1
  fi
  mv "$tmp" "$2"
}

mkdir -p "$DEST"
fetch "ccx-${os}-${arch}" "$DEST/ccx"
chmod +x "$DEST/ccx"
echo "ccx: installed to $DEST/ccx"

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "ccx: $DEST is not on your PATH — add it to your shell rc" >&2 ;;
esac

"$DEST/ccx" --version

[ "$WITH_AGENT" = 1 ] || exit 0

# ccx-agent: the binary, then a user service. Never a system unit, never root (#90).
fetch "ccx-agent-${os}-${arch}" "$DEST/ccx-agent"
chmod +x "$DEST/ccx-agent"
echo "ccx: installed to $DEST/ccx-agent ($("$DEST/ccx-agent" --version))"

HOOKS="https://github.com/${REPO}/blob/main/apps/agent/README.md#wiring-the-hooks"

supervise_yourself() {
  echo "ccx: $1, so ccx-agent is installed but not started." >&2
  echo "ccx: keep '$DEST/ccx-agent serve' running under your own supervisor, as your user." >&2
  echo "ccx: then wire the hooks: $HOOKS" >&2
}

if [ "$os" != linux ]; then
  # ponytail: no launchd agent yet (#92); nothing runs ccx-agent on macOS today
  supervise_yourself "no launchd setup yet on macOS"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  supervise_yourself "no systemd user manager here"
  exit 0
fi

units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$units"

# Before #131 the agent was ccxd. An old unit left enabled would run a second agent
# on the same spool with a different lock file.
if [ -f "$units/ccxd.service" ]; then
  systemctl --user disable --now ccxd >/dev/null 2>&1 || true
  rm -f "$units/ccxd.service"
  echo "ccx: removed the old ccxd user service"
fi

fetch ccx-agent.service "$units/ccx-agent.service"
# The unit starts %h/.local/bin/ccx-agent; point it at where this install put it.
sed "s|%h/.local/bin/ccx-agent|$DEST/ccx-agent|" "$units/ccx-agent.service" > "$units/ccx-agent.service.tmp"
mv "$units/ccx-agent.service.tmp" "$units/ccx-agent.service"

systemctl --user daemon-reload
systemctl --user enable ccx-agent >/dev/null 2>&1
# restart, not start: on an upgrade the running agent must pick up the new binary.
systemctl --user restart ccx-agent
echo "ccx: ccx-agent is running as a user service (systemctl --user status ccx-agent)"

if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
  echo "ccx: to keep ccx-agent up across logout, run: loginctl enable-linger $(id -un)"
fi

echo "ccx: next, wire the hooks and point it at a center: $HOOKS"
