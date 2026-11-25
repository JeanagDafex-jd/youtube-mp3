FROM node:22-slim

# yt-dlp (ejecutable independiente, no necesita Python)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 10000

# Intenta actualizar yt-dlp en cada arranque (YouTube cambia seguido) y luego inicia el servidor.
CMD ["sh", "-c", "yt-dlp -U || true; exec node server.js"]
