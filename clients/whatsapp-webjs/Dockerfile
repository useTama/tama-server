# whatsapp-web.js drives a real WhatsApp Web page, so this image carries a
# browser. Puppeteer publishes no arm64 Chromium download, and this deploys to
# Graviton as often as x86, so use Debian's package and skip the download.
FROM node:22-bookworm-slim

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Every module, not a list of them. Naming files here meant that adding one to
# bridge.mjs built an image without it, and the bridge crash-looped on
# ERR_MODULE_NOT_FOUND with WhatsApp showing one grey tick - a dead client that
# looks exactly like a dead server. http-error.mjs, whose whole purpose was to
# stop a failure being unreadable, is the file that did it.
COPY *.mjs ./

# The WhatsApp session is the credential. It lives in a volume so a rebuild
# does not mean scanning the QR again.
ENV WA_SESSION_DIR=/session
VOLUME ["/session"]

CMD ["node", "bridge.mjs"]
