#!/bin/sh
# Builds tama-server from source and puts the binary on your PATH.
#
# There are no binary releases yet, so this compiles rather than downloads. It
# touches exactly two places: a build directory it removes on the way out, and
# $PREFIX/bin. It never writes config, never creates a vault, and never needs
# root unless you point PREFIX somewhere that does.
#
#   curl -fsSL https://raw.githubusercontent.com/useTama/tama-server/main/scripts/install.sh | sh
#
set -eu

PREFIX=${PREFIX:-$HOME/.local}
REPO=${TAMA_REPO:-https://github.com/useTama/tama-server}
REF=${TAMA_REF:-main}

say()  { printf '%s\n' "$*"; }
die()  { printf 'install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
  Darwin) pkg="brew install" ;;
  Linux)  pkg="sudo apt install" ;;
  *)      pkg="your package manager" ;;
esac

have git || die "git is not installed. $pkg git"
have bun || die "bun is not installed. See https://bun.sh, or: curl -fsSL https://bun.sh/install | bash"
have ffmpeg || say "warning: ffmpeg is not installed. Audio capture needs it: $pkg ffmpeg"

build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT INT TERM

say "Fetching $REPO ($REF)"
git clone --depth 1 --branch "$REF" "$REPO" "$build/src" >/dev/null 2>&1 \
  || die "could not clone $REPO at $REF"

say "Building"
( cd "$build/src" && bun install --silent && bun run build ) >/dev/null \
  || die "build failed. Run it by hand in $build/src to see why"

mkdir -p "$PREFIX/bin"
# Replace by rename so a running server keeps its open binary and the swap is
# atomic; installing over a busy file is the one way this can half-succeed.
cp "$build/src/dist/tama-server" "$PREFIX/bin/.tama-server.new"
chmod 755 "$PREFIX/bin/.tama-server.new"
mv "$PREFIX/bin/.tama-server.new" "$PREFIX/bin/tama-server"

say ""
say "Installed $PREFIX/bin/tama-server"
case ":$PATH:" in
  *":$PREFIX/bin:"*) say "Next: tama-server setup" ;;
  *) say "  $PREFIX/bin is not on your PATH. Add it:"
     say "    echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> ~/.profile"
     say ""
     say "Next: $PREFIX/bin/tama-server setup" ;;
esac
