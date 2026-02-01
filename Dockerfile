# ----------------------------------------
# SageScript Worker (Node + FFmpeg)
# Production, HIPAA-conscious build
# ----------------------------------------

# 1) Base image with Node
FROM node:20-alpine AS base
WORKDIR /app

# 2) Dependencies layer
FROM base AS deps
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json* ./
RUN npm ci

# 3) Build layer
FROM deps AS builder
COPY . .
RUN npm run build   # must output to /dist

# 4) Runtime: minimal image with ffmpeg and non-root user
FROM node:20-alpine AS runner
RUN apk add --no-cache ffmpeg
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

WORKDIR /app
ENV NODE_ENV=production

# Copy runtime files only
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# HEALTHCHECK recommended
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD node -e "process.exit(0)"

# REMOVE this unless worker serves HTTP
# EXPOSE 3000

CMD ["npm", "run", "start"]
