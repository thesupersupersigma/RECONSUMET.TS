FROM node:22-alpine

RUN npm install -g pnpm

WORKDIR /app

# Build consumet library first
COPY consumet/ ./consumet/
WORKDIR /app/consumet
RUN pnpm install --ignore-scripts && npx tsc || true

# Install API
WORKDIR /app
COPY api/ ./api/
WORKDIR /app/api
RUN pnpm install --ignore-scripts

WORKDIR /app
EXPOSE 4001
ENV PORT=4001
ENV NODE_ENV=production

CMD ["node", "api/src/server.mjs"]