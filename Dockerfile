# syntax=docker/dockerfile:1
# Two images from one file: `docker build --target api .` and `docker build --target relay .`
# Debian bookworm-slim (glibc: wreq-js ships glibc prebuilts). Nothing is compiled for the build machine's CPU, so the
# images run on tsss-server's no-AVX Xeons.

FROM node:26-bookworm-slim AS build
RUN npm install -g pnpm@11.13.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/api/package.json packages/api/
COPY packages/relay/package.json packages/relay/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm --filter @reconsumet/api... --filter @reconsumet/relay... build \
 && pnpm --filter @reconsumet/api deploy --prod --legacy /out/api \
 && pnpm --filter @reconsumet/relay deploy --prod --legacy /out/relay

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api .
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM runtime AS relay
COPY --from=build --chown=node:node /out/relay .
ENV PORT=8081
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
