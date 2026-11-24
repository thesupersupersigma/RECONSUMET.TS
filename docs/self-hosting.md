# Self-hosting RECONSUMΣT.TS

**In plain English:** RECONSUMΣT.TS is three containers: a **Postgres** database, the **API** (what a site asks for
anime, episodes and streams) and the **relay** (which carries the video and subtitles to the viewer's browser). You
run all three with Docker Compose on any Linux machine: a home server, a VPS, a Raspberry Pi-class arm64 board. You
need two secrets in a `.env` file and nothing else. To put it on the internet you add HTTPS in front, either with the
bundled Caddy (one command, automatic certificates) or with the reverse proxy you already have. Video goes out through
**your** upload, so your upload speed decides how many people can watch at once.

## Requirements

- Linux, **x86-64** (any CPU, no AVX needed) or **arm64**, with Docker Engine and the Compose plugin
  (`docker compose version` should work). Windows/macOS with Docker Desktop work too, for testing.
- Disk: a few hundred MB for the images and the database.
- For public access: a domain (or two subdomains) pointing at the machine, and ports 80 + 443 reachable from outside.
- The upload speed of the connection limits how many viewers fit, see [Sizing bandwidth](#sizing-bandwidth).

## Quick start

```sh
git clone https://github.com/thesupersupersigma/RECONSUMET.TS.git && cd RECONSUMET.TS
cp .env.example .env                 # then set POSTGRES_PASSWORD and RELAY_SECRET in .env (openssl rand -base64 32)
docker compose up -d                 # builds the two images from this checkout, starts Postgres + API + relay
curl http://localhost:8080/v1/health # {"ok":true,...}; the browsable API is at http://localhost:8080/docs
docker compose exec api node dist/cli.js keys create mysite   # an API key for your site (shown once)
```

Instead of building, you can use the prebuilt multi-arch images (`linux/amd64`, `linux/arm64`):
`docker compose pull && docker compose up -d`. They are `ghcr.io/thesupersupersigma/reconsumet-api` and
`ghcr.io/thesupersupersigma/reconsumet-relay`, tagged with the version (`0.4.2`) and `latest`. Pin a version with
`RECONSUMET_VERSION=0.4.2` in `.env`.

The API applies its database migrations on every start, then imports the anime catalog within a minute (about
30 seconds). By default both services listen on `127.0.0.1` only (`API_PORT` 8080, `RELAY_PORT` 8081). Set
`BIND_ADDR=0.0.0.0` to reach them from other machines on your network.

## Secrets and API keys

- `RELAY_SECRET` (API and relay, the same value, at least 32 characters) seals every stream link. `POSTGRES_PASSWORD`
  is the bundled database's password. Generate each with `openssl rand -base64 32` or
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. They live only in `.env`, which
  is gitignored.
- **API keys** are for your site's server (never put one in browser code). Only a hash is stored:
  `docker compose exec api node dist/cli.js keys create <name> [requestsPerMinute]`, `keys list`, `keys revoke <id>`.
  **Or with no command at all:** put a key you generate yourself in `.env` as `API_BOOTSTRAP_KEY=` (at least 32
  characters, `openssl rand -base64 32`); the API creates it on start if it doesn't exist yet and leaves it alone
  after that. Give the same value to your site. Useful when one compose file starts the API and the site together.
  The streams route needs a key unless `REQUIRE_KEY_FOR_STREAMS=false`.
- **Rotating `RELAY_SECRET`:** set the relay's `RELAY_SECRET=<new>` and `RELAY_SECRET_PREVIOUS=<old>`, restart it;
  then give the API the new `RELAY_SECRET`, restart it; after 6 hours (`RELAY_CHILD_TTL_MIN`) drop
  `RELAY_SECRET_PREVIOUS`.

## Going public: HTTPS in front

The API and the relay each need a public HTTPS address. The site asks the API (server to server) and the viewer's
browser fetches video from the relay, so `RELAY_PUBLIC_URL` must be reachable by viewers. In `.env`:

```sh
PUBLIC_URL=https://api.example.com
RELAY_PUBLIC_URL=https://relay.example.com
RELAY_ALLOWED_ORIGINS=https://example.com    # your site's origin(s), comma-separated
TRUSTED_PROXIES=172.16.0.0/12                # the proxy's address as the containers see it (see below)
```

### Option A: the bundled Caddy (no reverse proxy yet)

Point `api.example.com` and `relay.example.com` at the machine (DNS `A`/`AAAA` records), open ports 80 and 443, and add
to `.env`:

```sh
API_DOMAIN=api.example.com
RELAY_DOMAIN=relay.example.com
```

Then `docker compose --profile caddy up -d`. Caddy gets and renews Let's Encrypt certificates by itself (it needs port
80 for that). Caddy reaches the services over the compose network, so `TRUSTED_PROXIES=172.16.0.0/12` (Docker's
private range; `docker network inspect reconsumet_default` shows the actual subnet) is right, and the default `BIND_ADDR=127.0.0.1` keeps the raw ports off the internet. Use
`--profile caddy` on every later `docker compose` command too (or set `COMPOSE_PROFILES=caddy` in `.env`).

### Option B: a reverse proxy you already run (nginx, Traefik, …)

Proxy each hostname to the published port on the host. nginx:

```nginx
server {
    server_name relay.example.com;   # listen 443 ssl + your certificates as usual
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;          # stream video through instead of buffering it
    }
}
# the same for api.example.com → http://127.0.0.1:8080
```

Traefik on the same Docker network: add the `api` and `relay` services to Traefik's network and give them the usual
`traefik.http.routers.<name>.rule=Host(...)` and `traefik.http.services.<name>.loadbalancer.server.port=8080/8081`
labels. A step-by-step example with Coolify is in [deploy/coolify.md](deploy/coolify.md).

`TRUSTED_PROXIES` must contain the proxy's address **as the containers see it**: a proxy on the host connects through
Docker's bridge (`172.16.0.0/12` covers it), a proxy in another container has that container's network address.
`docker compose logs api` plus a test request shows what arrives. Too wide (e.g. your whole LAN) lets those machines
fake their IP; empty means every viewer looks like the proxy, so the per-IP limits turn into one shared limit.

### Option C: behind Cloudflare or a tunnel

The **API** can sit behind Cloudflare (proxied DNS) or a Cloudflare Tunnel / other tunnel like any web app. Set
`CLIENT_IP_HEADER=CF-Connecting-IP` and put the address the tunnel connects from (e.g. the `cloudflared` container's
network) in `TRUSTED_PROXIES`.

The **relay should not**: Cloudflare's terms say that serving video or a disproportionate share of large files through
their CDN (which tunnels also use) needs their paid products (Stream etc.) unless you are an Enterprise customer, and
they may limit or disable the account otherwise. Give the relay a **DNS-only** record (no orange cloud) pointing at the
machine, and serve it with Caddy (option A) or your own proxy (option B). Check the terms of any other CDN or tunnel
before sending video through it.

## Where the relay lives

The relay has no database and no state: everything it needs is inside each sealed link. So it can run:

1. **On its own hostname** (default, shown above): `RELAY_PUBLIC_URL=https://relay.example.com`.
2. **Under a path on your one domain**, if you only have one name: `RELAY_PUBLIC_URL=https://example.com/relay`. The
   proxy must strip the prefix before passing the request on (the relay's links inside playlists are relative, so they
   keep the prefix by themselves). Caddy, in the `Caddyfile`:

   ```caddyfile
   example.com {
       handle_path /relay/* {
           reverse_proxy relay:8081
       }
       handle {
           reverse_proxy api:8080     # or your site
       }
   }
   ```

   nginx: `location /relay/ { proxy_pass http://127.0.0.1:8081/; proxy_buffering off; }` (the trailing `/` strips
   `/relay`).
3. **On another machine** (e.g. a VPS with more upload): on that machine copy `compose.yaml` and a `.env` with the
   same `RELAY_SECRET`, `RELAY_ALLOWED_ORIGINS` and its own `TRUSTED_PROXIES`, and run only the relay (plus Caddy if you
   want): `docker compose up -d relay`. On the API's machine set `RELAY_PUBLIC_URL` to the new address and
   `RELAY_SHARES_EGRESS_WITH_API=false`: some sources sign their links for the IP that asked (Re:Anime HD-1), and those
   don't play from another IP, so the API stops offering them. You can then stop the relay on the first machine.

## Sizing bandwidth

Every viewer's video goes out through the relay's upload. Measured per-stream bitrates (1080p): Re:Anime about
**6.5 Mbit/s**, AniZone about **3.5 Mbit/s**; 720p is roughly half. So:

- **viewers at once ≈ your upload ÷ bitrate.** A 40 Mbit/s upload carries about 5–6 Re:Anime 1080p viewers or ~10
  AniZone 1080p viewers. Test your upload with any speed test.
- `RELAY_GLOBAL_MBPS` (default **off**) caps the relay as a whole. Set it a little under your upload (e.g. 32 on a
  40 Mbit/s line) so the rest of your connection keeps working. Viewers beyond that don't get refused; everyone slows
  down together.
- `RELAY_IP_MBPS` (default **12**) caps one viewer. Players download faster than real time while they fill their
  buffer, so about twice the highest bitrate is right.
- `RELAY_MAX_STREAMS_PER_IP` (default 6) caps parallel downloads per viewer.
- CPU is not the limit: the relay used about 4.5 % of one old (2010) server core per 10 Mbit/s ([relay.md](relay.md)).

## Upgrades

```sh
git pull && docker compose up -d --build         # building yourself
docker compose pull && docker compose up -d      # prebuilt images (or change RECONSUMET_VERSION first)
```

Migrations run when the API starts (under a lock, so that's safe). Release notes are in the git tags.

## Backups

Everything worth keeping is in Postgres (API keys, mappings, caches, catalog). The relay keeps nothing.

```sh
docker compose exec -T postgres pg_dump -U reconsumet -Fc reconsumet > reconsumet-$(date +%F).dump
# restore into an empty database:
docker compose exec -T postgres pg_restore -U reconsumet -d reconsumet --clean --if-exists < reconsumet-2026-11-24.dump
```

The catalog and caches rebuild themselves, so the parts you can't get back are API keys and manual mapping overrides.

## Running without Docker (development, any OS)

Node 26, pnpm, and a Postgres you can reach (Compose uses 17; it needs the `pg_trgm` extension, which standard
Postgres packages include):

```sh
pnpm install
cp .env.example .env    # set RELAY_SECRET and DATABASE_URL=postgres://user:password@localhost:5432/reconsumet
pnpm dev                # builds, then runs API (:8080) and relay (:8081), restarting on changes
node --env-file=.env packages/api/dist/cli.js keys create dev
```

`pnpm test` needs no Postgres (it uses PGlite in memory).

## Every environment variable

`.env.example` lists them all with comments. Only `RELAY_SECRET` and `DATABASE_URL` are required (Compose builds
`DATABASE_URL` from `POSTGRES_PASSWORD`). An empty value means the default.

**API**

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | `postgres://user:pass@host:5432/db` |
| `RELAY_SECRET` | required | ≥ 32 characters, same value as the relay |
| `PUBLIC_URL` | `http://localhost:<PORT>` | the API's public URL (shown in `/openapi.json`) |
| `RELAY_PUBLIC_URL` | `http://localhost:8081` | the relay's public URL; stream links are `<this>/r/<token>.<ext>` |
| `PORT` | 8080 | listen port (Compose sets it inside the container) |
| `RELAY_TOKEN_TTL_MIN` | 10 | how long a fresh stream link can be *started* |
| `RELAY_SHARES_EGRESS_WITH_API` | true | `false` once the relay has another IP: IP-locked streams (Re:Anime HD-1) are dropped |
| `REQUIRE_KEY_FOR_STREAMS` | true | the streams route needs an API key |
| `TRUSTED_PROXIES` | empty | IPs/CIDRs whose client-IP header is believed |
| `CLIENT_IP_HEADER` | `X-Forwarded-For` | header with the viewer's IP, e.g. `CF-Connecting-IP`, `X-Real-IP`; only read from `TRUSTED_PROXIES` |
| `RATE_LIMIT_IP_PER_MIN` | 60 | requests/minute per IP without a key |
| `RATE_LIMIT_KEY_PER_MIN` | 600 | requests/minute per key (a key can have its own limit) |
| `JOBS_ENABLED` | true | run the catalog / AniList / health / cache jobs in this process |
| `RECONSUMET_ANILIST_DAILY_CAP` | 300 | AniList requests per UTC day (cache hits don't count) |
| `API_BOOTSTRAP_KEY` | empty | an API key (≥ 32 characters) created on start if missing; only its hash is stored |
| `API_BOOTSTRAP_KEY_NAME` | `bootstrap` | its name in `keys list` |
| `API_BOOTSTRAP_KEY_RPM` | empty | its own requests/minute (empty = `RATE_LIMIT_KEY_PER_MIN`) |

**Relay**

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_SECRET` | required | same value as the API |
| `RELAY_SECRET_PREVIOUS` | empty | the old secret during a rotation |
| `RELAY_ALLOWED_ORIGINS` | empty | site origins allowed to play from a browser (others get 403; players without `Origin` are allowed) |
| `TRUSTED_PROXIES`, `CLIENT_IP_HEADER` | empty, `X-Forwarded-For` | as for the API |
| `PORT` | 8081 | listen port |
| `RELAY_METRICS_TOKEN` | empty | bearer token for `/metrics` (404 when empty) |
| `RELAY_MAX_STREAMS_PER_IP` | 6 | parallel downloads per viewer IP |
| `RELAY_IP_MBPS` | 12 | bandwidth ceiling per viewer IP, Mbit/s |
| `RELAY_GLOBAL_MBPS` | off | bandwidth ceiling for everyone together, Mbit/s |
| `RELAY_CHILD_TTL_MIN` | 360 | lifetime of segment links minted while rewriting a playlist |
| `RELAY_MAX_PLAYLIST_LINES` | 20000 | longer playlists are refused |
| `RELAY_MAX_SEGMENT_MB` | 64 | biggest segment relayed, MiB |

**Compose only:** `POSTGRES_PASSWORD` (required), `BIND_ADDR` (127.0.0.1), `API_PORT` (8080), `RELAY_PORT` (8081),
`RECONSUMET_VERSION` (latest), `API_DOMAIN` / `RELAY_DOMAIN` (caddy profile). **Dev CLI only:** `RECONSUMET_DATA_DIR`
(`./data`).
