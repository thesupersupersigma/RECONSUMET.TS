FROM node:22-alpine

RUN npm install -g pnpm

# curl-impersonate: the /proxy route routes TLS_IMPERSONATE_HOSTS (flixcloud.cc, overcdn.site)
# through this binary to clear the CDN's Cloudflare/JA3 fingerprint gate. Without it,
# needsImpersonation() no-ops and those hosts 403 — reanime/flixcloud playback silently breaks.
# musl builds (Alpine-compatible), arch-selected at build time. Pin the version for reproducibility.
ARG CURL_IMPERSONATE_VERSION=v1.5.6
RUN apk add --no-cache ca-certificates libstdc++ \
    && case "$(uname -m)" in \
         x86_64)  CI_ARCH=x86_64-linux-musl ;; \
         aarch64) CI_ARCH=aarch64-linux-musl ;; \
         *) echo "unsupported arch $(uname -m) for curl-impersonate" >&2; exit 1 ;; \
       esac \
    && mkdir -p /opt/curl-impersonate \
    && wget -qO /tmp/ci.tar.gz \
         "https://github.com/lexiforest/curl-impersonate/releases/download/${CURL_IMPERSONATE_VERSION}/curl-impersonate-${CURL_IMPERSONATE_VERSION}.${CI_ARCH}.tar.gz" \
    && tar xzf /tmp/ci.tar.gz -C /opt/curl-impersonate \
    && rm /tmp/ci.tar.gz \
    && chmod +x /opt/curl-impersonate/curl-impersonate /opt/curl-impersonate/curl_* \
    && /opt/curl-impersonate/curl-impersonate --version | grep -q IMPERSONATE  # fail build if binary/musl libs don't resolve

# Point the API at the installed binary. Single-binary build → --impersonate selects the profile.
ENV CURL_IMPERSONATE_BIN=/opt/curl-impersonate/curl-impersonate
ENV CURL_IMPERSONATE_ARGS="--impersonate chrome124"
ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

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