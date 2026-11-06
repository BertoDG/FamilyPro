FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Madrid DB_FILE=/data/familypro.db PORT=3000
RUN apk add --no-cache tzdata
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
