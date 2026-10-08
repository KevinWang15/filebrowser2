FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && node scripts/package-release.mjs /runtime

FROM ghcr.io/puppeteer/puppeteer:25.9.0 AS verification
USER root
COPY --from=build /usr/local/ /usr/local/
WORKDIR /app
COPY --from=build /app/node_modules/ ./node_modules/
COPY . .
COPY --from=build /app/dist/ ./dist/
RUN ln -s /home/pptruser/.cache/puppeteer/chrome/*/chrome-linux64/chrome /usr/local/bin/filebrowser-chromium
ENV FB_CHROMIUM_PATH=/usr/local/bin/filebrowser-chromium
CMD ["npm", "run", "check"]

FROM node:24-bookworm-slim AS smb
COPY --from=build /etc/ssl/certs/ /etc/ssl/certs/
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends samba samba-common-bin passwd && rm -rf /var/lib/apt/lists/*
RUN mkdir /control /files /samba-state && chown node:node /control /files && chmod 700 /control
WORKDIR /app
COPY --from=build /app/dist/server/samba-agent.js ./agent.mjs
COPY --from=build /app/LICENSE ./LICENSE
ENV FB_SMB_CONTROL_DIR=/control FB_SMB_ALLOWED_ROOTS='["/files"]' FB_SMB_STATE_DIR=/samba-state
EXPOSE 445
CMD ["node", "agent.mjs"]

FROM smb AS smb-verification
RUN apt-get update && apt-get install -y --no-install-recommends smbclient && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/scripts/verify-container-shares.mjs /app/scripts/verification-targets.mjs ./
CMD ["node", "verify-container-shares.mjs"]

FROM node:24-bookworm-slim AS runtime
ARG FB_BUILD_COMMIT=local
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 FB_SETUP_LOCAL_PATH=/files FB_STATE_DIR=/state
ENV FB_BUILD_COMMIT=$FB_BUILD_COMMIT
WORKDIR /app
RUN mkdir /files /state /state/protocols && chown node:node /files /state /state/protocols
RUN chmod 700 /state /state/protocols
# The packaged server graph is JavaScript; Node supplies SQLite on each platform.
COPY --from=build /runtime/app/ ./
COPY --from=build /runtime/LICENSE /runtime/NOTICE.md /runtime/THIRD_PARTY_NOTICES.md ./
COPY --from=build /runtime/licenses ./licenses
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server/server.js"]
