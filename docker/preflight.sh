#!/bin/sh
# Run this on the server BEFORE installing anything. It only reports.
echo "== os          =="; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME  $(uname -m)"
echo "== resources   =="; free -h 2>/dev/null | sed -n 1,2p; df -h / | tail -1; nproc | sed 's/^/cpus: /'
echo "== docker      =="
if command -v docker >/dev/null 2>&1; then
  docker --version
  docker compose version 2>/dev/null || echo "docker compose plugin: MISSING"
  docker info >/dev/null 2>&1 && echo "daemon: reachable as $(id -un)" \
    || echo "daemon: NOT reachable (needs sudo, or add yourself to the docker group)"
else
  echo "docker: MISSING"
fi
echo "== port 8080   =="; (ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -E ':(8080|8081)\b' || echo "8080/8081 free"
echo "== git/ffmpeg on host (not required, containers carry their own) =="
for b in git ffmpeg openssl; do
  if command -v "$b" >/dev/null 2>&1; then echo "$b: $($b --version 2>&1 | head -1)"; else echo "$b: MISSING"; fi
done
echo "== existing tama =="; docker ps -a --filter name=tama 2>/dev/null | tail -n +1
