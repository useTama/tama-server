#!/bin/sh
set -e

# The vault must be git-tracked before the server will write to it; a fresh
# named volume is an empty directory, so make it a repo once.
if [ ! -d /vault/.git ]; then
  git init -q /vault
  echo "tama: initialized git vault at /vault"
fi

exec "$@"
