#!/bin/sh
# Signs the shortcuts in this directory so they can be handed to another device.
#
# iOS will not import a shortcut nobody has signed. The `shortcuts` tool ships
# with macOS 12 and signs with your own identity, so the output is yours to
# share and is not something this repository can produce for you.
#
#   ./sign.sh              -> dist/*.shortcut, shareable with anyone
#   MODE=people-who-know-me ./sign.sh
#
set -eu

MODE=${MODE:-anyone}
OUT=${OUT:-dist}

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$here"

command -v shortcuts >/dev/null 2>&1 || {
  printf 'sign: needs the macOS `shortcuts` tool (macOS 12 or later).\n' >&2
  printf 'On Linux or Windows, build the shortcuts by hand instead — see README.md.\n' >&2
  exit 1
}

mkdir -p "$OUT"
for src in *.shortcut; do
  [ -e "$src" ] || { printf 'sign: no .shortcut files here\n' >&2; exit 1; }
  plutil -lint "$src" >/dev/null || exit 1
  shortcuts sign --mode "$MODE" --input "$src" --output "$OUT/$src"
  printf '  %s\n' "$OUT/$src"
done

printf '\nAirDrop those to the phone, or put them somewhere it can download from.\n'
printf 'Signing does not check that the actions are correct, only that the file is intact.\n'
