FROM node:22-alpine
WORKDIR /app
# Sin DATABASE_URL usa Postgres embebido (PGlite) guardado en /data/pglite.
ENV NODE_ENV=production APP_TZ=Europe/Madrid PGLITE_DIR=/data/pglite PORT=3000
RUN apk add --no-cache tzdata
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
