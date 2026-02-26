FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/data/bot.db
RUN groupadd -r bot && useradd -r -g bot bot
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data && chown -R bot:bot /app /data
USER bot
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
