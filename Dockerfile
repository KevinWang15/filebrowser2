FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ghcr.io/puppeteer/puppeteer:25.9.0 AS verification
USER root
COPY --from=build /usr/local/ /usr/local/
WORKDIR /app
COPY --from=build /app/ /app/
RUN ln -s /home/pptruser/.cache/puppeteer/chrome/*/chrome-linux64/chrome /usr/local/bin/filebrowser-chromium
ENV FB_CHROMIUM_PATH=/usr/local/bin/filebrowser-chromium
CMD ["npm", "run", "check"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 FB_STORAGE_ROOT=/files FB_STATE_DIR=/state
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /files /state && chown node:node /files /state
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server/server.js"]
