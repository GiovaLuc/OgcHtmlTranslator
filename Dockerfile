FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dipendenze prima del codice, per sfruttare la cache dei layer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# OUT_DIR scrivibile dall'utente non-root (vale anche per un named volume, che eredita
# owner e permessi di questa cartella alla prima creazione)
RUN mkdir -p /app/out && chown node:node /app/out
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "translator.js"]
