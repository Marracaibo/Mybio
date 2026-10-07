# Immagine del motore: servizio sempre acceso (webhook di OpenWA + pianificazione di rss, adatta e invia).
FROM node:22-alpine

# Gli orari della pianificazione seguono TZ (es. Europe/Rome): Node usa i fusi di ICU, non serve tzdata.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY modello-cartella-condivisa ./modello-cartella-condivisa

# Stato, log e copie dei sorgenti in /dati; cartella condivisa (sincronizzata con Google Drive) in /condivisa.
# Nessun segreto nell'immagine: arrivano dal file .env tramite docker compose.
RUN mkdir -p /dati /condivisa && chown node:node /dati /condivisa
ENV DATI_DIR=/dati \
    SHARED_DIR=/condivisa \
    PORTA_SERVIZIO=3000 \
    NODE_ENV=production

USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/salute >/dev/null || exit 1
CMD ["node", "--import", "tsx", "src/servizio.ts"]
