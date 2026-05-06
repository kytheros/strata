# Multi-stage Node 22 Dockerfile for the example-agent Next.js app.
#
# `output: 'standalone'` in next.config.mjs means the build emits a
# minimal `server.js` + the trace-resolved subset of node_modules into
# .next/standalone, which we copy verbatim into the runtime stage. No
# install in runtime — image stays under ~200MB.

# Stage 1: deps (npm install with --ignore-scripts per repo policy)
FROM node:22-alpine AS deps

WORKDIR /app
COPY package*.json ./

# Repo-wide policy: --ignore-scripts blocks the postinstall execution
# vector that has produced npm supply-chain incidents. None of the deps
# in this app require build scripts (next/react/aws-jwt-verify/aws-sdk
# are pure JS or precompiled). If a future native dep requires
# rebuilding, add an explicit `npm rebuild --ignore-scripts=false <pkg>`
# step here.
RUN npm ci --ignore-scripts

# Stage 2: build
FROM node:22-alpine AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Disable Next telemetry in CI builds — keeps the build deterministic
# and avoids a network call to Vercel.
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time placeholders so Next.js page collection passes the
# requireEnv() checks in app/lib/config.ts. Real values are injected at
# runtime by the ECS task definition. These don't propagate to the
# runtime stage (separate FROM block).
ENV COGNITO_USER_POOL_ID=us-east-1_BuildPlaceholder \
    COGNITO_CLIENT_ID=BuildPlaceholderClientId \
    COGNITO_HOSTED_UI_DOMAIN=build-placeholder \
    APP_URL=https://build-placeholder.example.com

RUN npm run build

# Stage 3: runtime
FROM node:22-alpine AS runtime

WORKDIR /app

# Run as non-root. node:22-alpine ships with a `node` user (uid 1000)
# but we create our own to make the constraint explicit.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Copy only what the standalone server needs — public assets, the
# server bundle, and the static-asset directory.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# Healthcheck used by ECS service definition. Plain HTTP — TLS is
# terminated upstream by ALB or API GW.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
