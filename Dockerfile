# ----------------------------------------
# SageScript Worker (Node + FFmpeg)
# Production, HIPAA-conscious build
# ----------------------------------------

# 1) Base image with Node
FROM node:20-alpine AS base

WORKDIR /app

# 2) Dependencies layer
FROM base AS deps

# FFmpeg for audio normalization/transcoding
RUN apk add --no-cache ffmpeg

# Copy dependency manifests
COPY package.json package-lock.json* ./

# Install full deps for build
RUN npm ci

# 3) Build layer
FROM deps AS builder

# Copy the rest of the worker source
COPY . .

# If you use TypeScript, ensure "build" compiles to /dist
# If not using TS, this can still be harmless (or you can remove it)
RUN npm run build

# 4) Runtime: minimal, non-root, with ffmpeg
FROM node:20-alpine AS runner

# Install ffmpeg in runtime as well (worker needs it at runtime)
RUN apk add --no-cache ffmpeg

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app
ENV NODE_ENV=production

# Copy only what's required to run
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# If your compiled output is not in /dist (e.g. /build or still /src),
# adjust the path above accordingly.

# Drop dev dependencies
RUN npm prune --omit=dev

USER appuser

# Expose port only if your worker exposes an HTTP interface on 3000
EXPOSE 3000

# Start worker (adjust if your start script is different)
CMD ["npm", "run", "start"]
