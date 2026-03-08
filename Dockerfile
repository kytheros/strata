# Stage 1: Build
FROM node:22-alpine AS builder

# better-sqlite3 requires native compilation tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine

# better-sqlite3 needs libstdc++ at runtime
RUN apk add --no-cache libstdc++ && addgroup -S strata && adduser -S strata -G strata

WORKDIR /app

COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json .

RUN mkdir -p /data && chown strata:strata /data

ENV STRATA_DATA_DIR=/data PORT=8080

EXPOSE 8080

USER strata

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "dist/cli.js", "serve", "--port", "8080"]
