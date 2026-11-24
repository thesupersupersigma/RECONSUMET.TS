# Deploying RECONSUMΣT.TS (API + relay) on tsss-server with Coolify

**In plain English:** there are two services, built from the same `Dockerfile`. The **API** goes behind the existing
Cloudflare Tunnel like your other apps, and stores its data in its own Postgres database. The **relay** carries the
video, which Cloudflare's tunnel must not carry. It gets its own hostname whose DNS record points straight at your
home IP (DNS-only, grey cloud), with port 443 forwarded to tsss-server, where Coolify's Traefik serves it with a Let's
Encrypt certificate. The two services share one secret (`RELAY_SECRET`) and nothing else, so the relay can later move
to a VPS by changing DNS and two settings.

You need: the repo on GitHub, Coolify on tsss-server, access to the Cloudflare dashboard and the router.

## 1. Postgres database + user

In Coolify, open the Postgres you want to use (the shared one, or create **New Resource → Database → PostgreSQL 17**).
Open its terminal (or `psql` as the `postgres` superuser) and run, with your own password:

```sql
CREATE ROLE reconsumet LOGIN PASSWORD 'long-random-password';
CREATE DATABASE reconsumet OWNER reconsumet;
\c reconsumet
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy title search; the migration tries too, but may lack the right
```

Your connection string is `postgres://reconsumet:<password>@<postgres-host>:5432/reconsumet`. `<postgres-host>` is the
database's internal hostname that Coolify shows (both must be on the same Docker network: tick "Connect to
predefined network" on the API, or use the Postgres's public port on `10.0.0.140`).

## 2. Secrets

```sh
# RELAY_SECRET: shared by API and relay (at least 32 characters)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# RELAY_METRICS_TOKEN: only you need it (for /metrics)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

(`openssl rand -base64 32` works too.) Never commit them. `.env` is gitignored, and `.env.example` only lists the names.

## 3. The API (through the Cloudflare Tunnel)

1. Coolify → **New Resource → Application → Public/Private repository**, RECONSUMET.TS, branch `master`.
2. Build pack **Dockerfile**. In the build settings set **Docker Build Stage Target = `api`**. Port **8080**.
3. Domain: the hostname you route through the tunnel, e.g. `https://reconsumet-api.thesupersupersigma.com`. Add it as a
   public hostname in the Cloudflare Tunnel the same way as your other Coolify apps.
4. Environment variables (table below): at least `DATABASE_URL`, `PUBLIC_URL`, `RELAY_PUBLIC_URL`, `RELAY_SECRET`,
   `TRUSTED_PROXIES`.
5. Deploy. On start the API applies its database migrations (under a lock), then serves. The jobs start within a
   minute: the first catalog import takes ~30 s. Check `https://<api-host>/v1/health` and `/docs`.
6. Create the site's API key in the API container's terminal (Coolify → the app → Terminal):
   `node dist/cli.js keys create site`. The key is shown **once**. Put it in the site's env, never in browser code.
   `node dist/cli.js keys list` / `keys revoke <id>` manage keys later.

## 4. The relay (its own hostname, DNS-only)

1. **DNS:** in Cloudflare add an `A` record `relay` → your home public IP, **proxy status: DNS only (grey cloud)**.
   This makes your home IP visible in DNS, which is accepted in brainstorm 1.26. If your home IP changes, this record
   must be updated (a DDNS updater helps).
2. **Router:** forward TCP **443** to tsss-server (`10.0.0.140`), where Coolify's Traefik listens. Also forward **80**,
   unless you switch Traefik to Cloudflare DNS challenges. Let's Encrypt's default HTTP challenge (issue and renewal
   every ~60 days) needs it. Traefik only answers hostnames it knows, so your other apps stay unreachable this way.
3. Coolify → **New Resource → Application**, same repo, Dockerfile build pack, **Docker Build Stage Target =
   `relay`**, port **8081**, domain `https://relay.thesupersupersigma.com`. Coolify's Traefik requests the certificate.
4. Environment variables (table below): `RELAY_SECRET` (same as the API), `RELAY_ALLOWED_ORIGINS` (the site's
   origins, e.g. `https://thesupersuperanime.lol`), `TRUSTED_PROXIES` (Coolify's proxy network, see below),
   `RELAY_METRICS_TOKEN`.
5. Deploy and check `https://relay.thesupersupersigma.com/health` from outside your network (e.g. phone on mobile data).

**`TRUSTED_PROXIES`:** the services only believe `X-Forwarded-For` from these addresses. Use the subnet of Coolify's
proxy network: `docker network inspect coolify --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'` on tsss-server.
Too wide (e.g. all of `10.0.0.0/8`, which includes your LAN) lets LAN devices fake their IP. Empty means every viewer
looks like Traefik's address, so the per-IP limits become one shared limit.

## Every environment variable

**API**

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | `postgres://user:pass@host:5432/db` |
| `PUBLIC_URL` | required | the API's public URL (shown in `/openapi.json`) |
| `RELAY_PUBLIC_URL` | required | the relay's public URL; stream links are `<this>/r/<token>.<ext>` |
| `RELAY_SECRET` | required | ≥ 32 characters, same value as the relay |
| `PORT` | 8080 | listen port inside the container |
| `RELAY_TOKEN_TTL_MIN` | 10 | how long a fresh stream link can be *started* |
| `RELAY_SHARES_EGRESS_WITH_API` | true | `false` once the relay has another IP: Re:Anime HD-1 (IP-locked) is no longer offered |
| `REQUIRE_KEY_FOR_STREAMS` | true | streams route needs an API key |
| `TRUSTED_PROXIES` | empty | IPs/CIDRs whose `X-Forwarded-For` is believed |
| `RATE_LIMIT_IP_PER_MIN` | 60 | requests/minute per IP without a key |
| `RATE_LIMIT_KEY_PER_MIN` | 600 | requests/minute per key (a key can have its own limit) |
| `JOBS_ENABLED` | true | run the catalog / AniList / health / cache jobs in this process |
| `RECONSUMET_ANILIST_DAILY_CAP` | 300 | AniList requests per UTC day (cache hits don't count) |

**Relay**

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_SECRET` | required | same value as the API |
| `RELAY_SECRET_PREVIOUS` | empty | the old secret during a rotation |
| `RELAY_ALLOWED_ORIGINS` | empty | comma-separated site origins allowed to play (browser requests from others get 403) |
| `TRUSTED_PROXIES` | empty | as above |
| `PORT` | 8081 | listen port inside the container |
| `RELAY_METRICS_TOKEN` | empty | bearer token for `/metrics` (404 when empty) |
| `RELAY_MAX_STREAMS_PER_IP` | 6 | parallel downloads per viewer IP |
| `RELAY_IP_MBPS` | 12 | bandwidth ceiling per viewer IP, Mbit/s |
| `RELAY_GLOBAL_MBPS` | 32 | bandwidth ceiling for everyone together, Mbit/s (keep it under the upload speed) |
| `RELAY_CHILD_TTL_MIN` | 360 | lifetime of segment links minted while rewriting a playlist |
| `RELAY_MAX_PLAYLIST_LINES` | 20000 | longer playlists are refused |
| `RELAY_MAX_SEGMENT_MB` | 64 | biggest segment relayed, MiB |

## Rotating `RELAY_SECRET`

1. Relay: set `RELAY_SECRET=<new>` and `RELAY_SECRET_PREVIOUS=<old>`, redeploy.
2. API: set `RELAY_SECRET=<new>`, redeploy.
3. After 6 hours (`RELAY_CHILD_TTL_MIN`), remove `RELAY_SECRET_PREVIOUS` from the relay.

## Moving the relay to a VPS later

The relay has no database and keeps no state, so moving it is configuration only:

1. On the VPS run the relay image behind any TLS proxy (Caddy, Traefik, or Coolify on the VPS) with the **same
   environment** (`RELAY_SECRET`, `RELAY_ALLOWED_ORIGINS`, `TRUSTED_PROXIES` for that proxy, …).
2. **DNS:** point the `relay` A record at the VPS's IP (still DNS-only). If you keep the hostname, **`RELAY_PUBLIC_URL`
   doesn't change**. If you pick a new hostname, update `RELAY_PUBLIC_URL` on the API.
3. **API:** set `RELAY_SHARES_EGRESS_WITH_API=false`. Re:Anime HD-1 links only work from the IP that resolved them, so
   the API stops offering them (HD-2 plays anywhere).
4. Remove the home router's port forward for 443/80 and set `RELAY_GLOBAL_MBPS` to the VPS's real upload
   (OCI micro: ~50 Mbit/s measured by others).

## Local / dev

```sh
cp .env.example .env    # fill in RELAY_SECRET and POSTGRES_PASSWORD
docker compose up --build
# API http://localhost:8080/docs, relay http://localhost:8081/health
docker compose exec api node dist/cli.js keys create dev
```

`compose.yaml` runs Postgres 17 + API + relay. The API migrates its database on start.
