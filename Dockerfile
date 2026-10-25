# --- build -----------------------------------------------------------------
FROM node:26-slim AS builder
# build tools are only needed if better-sqlite3 has no prebuild for this
# platform/node version; the compile fallback is slow but self-contained.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ---------------------------------------------------------------
FROM node:26-slim
ENV NODE_ENV=production \
    SPARKFLY_DATA_DIR=/data \
    RULES_FILE=/config/rules.yaml \
    PORT=8080
WORKDIR /app
RUN groupadd --system sparkfly && useradd --system --gid sparkfly --home /app sparkfly
# /data is a VOLUME; pre-create it owned by the app user so anonymous
# volumes are writable (bind mounts inherit host ownership).
RUN mkdir -p /data && chown sparkfly:sparkfly /data
COPY --from=builder --chown=sparkfly:sparkfly /app/node_modules ./node_modules
COPY --from=builder --chown=sparkfly:sparkfly /app/dist ./dist
COPY --chown=sparkfly:sparkfly package.json ./package.json
COPY --chown=sparkfly:sparkfly LICENSE README.md ./
USER sparkfly
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
