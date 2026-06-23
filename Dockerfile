FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

# /data монтируется как Fly.io volume — там хранится ssfn.json между деплоями
RUN mkdir -p /data

ENV DATA_DIR=/data
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "index.js"]
