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

COPY bridge.mjs ./

# The WhatsApp session is the credential. It lives in a volume so a rebuild
# does not mean scanning the QR again.
ENV WA_SESSION_DIR=/session
VOLUME ["/session"]

CMD ["node", "bridge.mjs"]
