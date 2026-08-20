# syntax=docker/dockerfile:1

# Debian slim (glibc), not Alpine: sodium-native (a transitive dependency of
# @stellar/stellar-sdk) ships prebuilt native bindings for glibc but not
# reliably for musl, which would otherwise force a full build toolchain
# (python3/make/g++) into the image just to compile it from source.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY index.js stellar.js ./
COPY src ./src

# The base image ships a non-root `node` user (uid 1000) — use it instead
# of running as root.
RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
