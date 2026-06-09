FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production && mkdir -p /app/data

COPY index.js ./

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "process.exit(0)"

CMD ["node", "index.js"]
