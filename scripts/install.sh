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

# The service decision comes before any download, so a host that cannot take the
# agent's service replaces nothing. (A failure after the binaries are in place —
# the agent's --version, writing the unit, or any systemctl call — leaves them in place.)
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
  # The manager's own config dir is the first */systemd/user entry of its
  # UnitPath (unless the manager runs with SYSTEMD_UNIT_PATH set, which replaces
  # the list). show-environment is what units are given, not what the manager
  # searches, so an XDG_CONFIG_HOME there (or in this shell) can point elsewhere.
  # ponytail: UnitPath is space-separated; a dir with a space splits into pieces,
  # and only an absolute piece is taken, so such a dir is not found
  # An assignment of its own: a failing command substitution in a for list does not stop set -e.
  unit_path=$(systemctl --user show -p UnitPath --value)
  unit_dir=""
  for p in $unit_path; do
    case "$p" in /*/systemd/user) unit_dir=$p; break ;; esac
  done
  if [ -z "$unit_dir" ]; then
    echo "ccx: cannot find the user manager's unit directory in its UnitPath" >&2
    exit 1
  fi
  mkdir -p "$unit_dir" 2>/dev/null || true
  if [ ! -w "$unit_dir" ]; then
    echo "ccx: cannot write the user manager's unit directory: $unit_dir" >&2
    exit 1
  fi
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

# The unit starts %h/.local/bin/ccx-agent; point it at where this install put it.
# It also gets this shell's PATH, so the resumes ccx-agent runs find herdr as the
# user does. Entries a unit would read differently are left out one by one: not
# absolute (resolved against the service's cwd, not this shell's), or with a
# character systemd or the sed below treats specially (space, %, quotes, \, &, |).
unit_path=""
dropped=""
set -f
old_ifs=$IFS
IFS=:
for d in $PATH; do
  case "$d" in
    /*[!A-Za-z0-9/._@+,~-]*) dropped="$dropped '$d'" ;;
    /*) unit_path="${unit_path:+$unit_path:}$d" ;;
    *) dropped="$dropped '$d'" ;;
  esac
done
IFS=$old_ifs
set +f
# Field splitting drops a trailing empty field, which in PATH means the cwd as well.
case "$PATH" in *:) dropped="$dropped ''" ;; esac
# A fresh install from a shell that does not have the install dir on PATH yet still
# gives the unit that dir, where ccx and, often, herdr are.
case ":$unit_path:" in
  *":$DEST:"*) ;;
  *) unit_path="$DEST${unit_path:+:$unit_path}" ;;
esac
if [ -n "$dropped" ]; then
  echo "ccx: left out of the unit's PATH (not absolute, or characters a unit cannot carry as is):$dropped" >&2
fi
sed -e "s|%h/.local/bin/ccx-agent|$DEST/ccx-agent|" -e "s|^Environment=PATH=.*|Environment=PATH=$unit_path|" "$stage/ccx-agent.service" > "$unit_dir/ccx-agent.service"
if ! PATH=$unit_path command -v herdr >/dev/null 2>&1; then
  echo "ccx: herdr is not on the PATH the unit was given ($unit_path), so a resume through ccx-center cannot open a session here; install herdr into one of those dirs, or add its dir to the unit (systemctl --user edit ccx-agent)" >&2
fi

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
