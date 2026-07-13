#!/bin/sh
# Install the latest ccx release.
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/ccx/main/scripts/install.sh | sh
#
# Override the destination with CCX_INSTALL_DIR (default: ~/.local/bin).
# Pin a version with CCX_VERSION (default: latest).

set -eu

REPO="TakashiAihara/ccx"
DEST="${CCX_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CCX_VERSION:-latest}"

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

asset="ccx-${os}-${arch}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

echo "ccx: downloading ${asset} (${VERSION})"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

if ! curl -fsSL "$url" -o "$tmp"; then
  echo "ccx: no binary at $url" >&2
  echo "ccx: check the available releases: https://github.com/${REPO}/releases" >&2
  exit 1
fi

mkdir -p "$DEST"
chmod +x "$tmp"
mv "$tmp" "$DEST/ccx"
trap - EXIT

echo "ccx: installed to $DEST/ccx"

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "ccx: $DEST is not on your PATH — add it to your shell rc" >&2 ;;
esac

"$DEST/ccx" --version
