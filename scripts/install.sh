#!/bin/sh
# Install the latest ccx release.
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/ccx/main/scripts/install.sh | sh
#
# Add the resident agent (ccx-agent) as a systemd user service with --with-agent:
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/ccx/main/scripts/install.sh | sh -s -- --with-agent
#
# Override the destination with CCX_INSTALL_DIR (default: ~/.local/bin).
# Pin a version with CCX_VERSION (default: latest).

set -eu

REPO="TakashiAihara/ccx"
DEST="${CCX_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CCX_VERSION:-latest}"
# Where releases are downloaded from. Only the tests point it elsewhere.
BASE="${CCX_DOWNLOAD_URL:-https://github.com/${REPO}/releases}"
WITH_AGENT=0

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

# The service decision comes before any download: nothing is replaced when the
# agent part cannot be done.
# none: ccx only. manual: ccx-agent too, supervised by the user. systemd: and a user unit.
service=none
if [ "$WITH_AGENT" = 1 ]; then
  service=manual
  # ponytail: no launchd agent yet (#92); nothing runs ccx-agent on macOS today
  if [ "$os" = linux ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    service=systemd
  fi
fi
if [ "$service" = systemd ]; then
  mkdir -p "$DEST"
  DEST=$(cd "$DEST" && pwd)
  # The path goes into the unit's ExecStart, where spaces split it and systemd
  # expands % specifiers.
  case "$DEST" in
    *[!A-Za-z0-9/._-]*) echo "ccx: --with-agent needs an install dir of plain characters, got: $DEST" >&2; exit 1 ;;
  esac
fi

# latest moves on every push to main. Resolve it once, so ccx, ccx-agent and the
# unit all come from one release.
if [ "$VERSION" = "latest" ]; then
  tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${BASE}/latest") || {
    echo "ccx: cannot resolve the latest release at ${BASE}/latest" >&2
    exit 1
  }
  VERSION=${tag##*/}
fi

mkdir -p "$DEST"
# Downloads land next to the destination, so the final mv is a rename: replacing
# a running ccx-agent by copying over it fails with "Text file busy".
stage="$DEST/.ccx-install.$$"
mkdir "$stage"
trap 'rm -rf "$stage"' EXIT INT TERM

fetch() {
  url="${BASE}/download/${VERSION}/$1"
  echo "ccx: downloading $1 (${VERSION})"
  if ! curl -fsSL "$url" -o "$stage/$2"; then
    echo "ccx: no file at $url" >&2
    echo "ccx: check the available releases: https://github.com/${REPO}/releases" >&2
    exit 1
  fi
}

fetch "ccx-${os}-${arch}" ccx
chmod +x "$stage/ccx"
if [ "$service" != none ]; then
  fetch "ccx-agent-${os}-${arch}" ccx-agent
  chmod +x "$stage/ccx-agent"
fi
if [ "$service" = systemd ]; then
  fetch ccx-agent.service ccx-agent.service
fi

mv "$stage/ccx" "$DEST/ccx"
echo "ccx: installed to $DEST/ccx"

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "ccx: $DEST is not on your PATH — add it to your shell rc" >&2 ;;
esac

"$DEST/ccx" --version

[ "$service" != none ] || exit 0

mv "$stage/ccx-agent" "$DEST/ccx-agent"
# An assignment of its own: inside echo's arguments a failing binary would not stop set -e.
agent_version=$("$DEST/ccx-agent" --version)
echo "ccx: installed to $DEST/ccx-agent ($agent_version)"

if [ "$service" = manual ]; then
  echo "ccx: 'systemctl --user' cannot reach a user manager here (or this is macOS), so no service was set up." >&2
  echo "ccx: keep '$DEST/ccx-agent serve' running as your user under your own supervisor." >&2
  echo "ccx: then point it at a center and wire the hooks with the command '$DEST/ccx-agent hook':" >&2
  echo "ccx:   https://github.com/${REPO}/blob/main/apps/agent/README.md#install" >&2
  exit 0
fi

# A user unit, never a system one: it runs as whoever ran this script (#90).
# The manager searches its own XDG_CONFIG_HOME, which need not match this shell's.
manager_config=$(systemctl --user show-environment | sed -n 's/^XDG_CONFIG_HOME=//p')
units="${manager_config:-$HOME/.config}/systemd/user"
mkdir -p "$units"
# The unit starts %h/.local/bin/ccx-agent; point it at where this install put it.
sed "s|%h/.local/bin/ccx-agent|$DEST/ccx-agent|" "$stage/ccx-agent.service" > "$units/ccx-agent.service"

systemctl --user daemon-reload
systemctl --user enable ccx-agent
# restart, not start: on an upgrade the running agent must pick up the new binary.
systemctl --user restart ccx-agent
echo "ccx: ccx-agent is running as a user service (systemctl --user status ccx-agent)"

if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
  echo "ccx: to keep ccx-agent up across logout, run: loginctl enable-linger $(id -un)"
fi

echo "ccx: next, point it at a center and wire the hooks with the command '$DEST/ccx-agent hook':"
echo "ccx:   https://github.com/${REPO}/blob/main/apps/agent/README.md#install"
