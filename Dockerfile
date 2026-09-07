# tama-server: bun runtime + ffmpeg (audio) + git (the vault is git-tracked).
FROM oven/bun:1-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source edit does not re-resolve the lockfile.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY src ./src
COPY tsconfig.json ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# The vault and the server's own state are both volumes; nothing durable
# lives in the image layer.
ENV TAMA_CONFIG=/etc/tama/tama.config.json
VOLUME ["/vault", "/data"]
EXPOSE 8080

# git refuses to commit without an identity, and the vault is a git repo the
# container owns.
RUN git config --system user.name  "tama-server" \
 && git config --system user.email "tama@localhost" \
 && git config --system --add safe.directory /vault

# Runs as root: the named volumes are root-owned and this is a single-tenant box.
USER root

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "run", "src/tama.ts"]
