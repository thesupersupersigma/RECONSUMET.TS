# Example: deploying with Coolify (optional)

**In plain English:** this is one optional way to run RECONSUMΣT.TS, for people who already use
[Coolify](https://coolify.io) on their server. The normal way is plain Docker Compose, see
[../self-hosting.md](../self-hosting.md), which also explains every setting. Here the two services are built by
Coolify from the same `Dockerfile`: the **API** behind Coolify's proxy like any other app (optionally through a
Cloudflare Tunnel), and the **relay** on its own hostname that is **not** proxied through Cloudflare, because
Cloudflare's terms don't allow video through their CDN on non-Enterprise plans. The two share one secret
(`RELAY_SECRET`) and nothing else.

Placeholders below: `<server-lan-ip>` (your server's address on your LAN), `api.example.com`, `relay.example.com`,
`https://example.com` (your site).

You need: the repo (your fork or this one), Coolify on the server, access to your DNS provider and, at home, the router.

## 1. Postgres database + user

In Coolify, open the Postgres you want to use (a shared one, or **New Resource → Database → PostgreSQL 17**). Open its
terminal (or `psql` as the `postgres` superuser) and run, with your own password:

```sql
CREATE ROLE reconsumet LOGIN PASSWORD 'long-random-password';
CREATE DATABASE reconsumet OWNER reconsumet;
\c reconsumet
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy title search; the migration tries too, but may lack the right
```

Your connection string is `postgres://reconsumet:<password>@<postgres-host>:5432/reconsumet`. `<postgres-host>` is the
database's internal hostname that Coolify shows (both must be on the same Docker network: tick "Connect to predefined
network" on the API, or use the Postgres's public port on `<server-lan-ip>`).

## 2. Secrets

`RELAY_SECRET` (shared by API and relay) and optionally `RELAY_METRICS_TOKEN`: `openssl rand -base64 32` each. See
[../self-hosting.md](../self-hosting.md#secrets-and-api-keys).

## 3. The API

1. Coolify → **New Resource → Application → Public/Private repository**, the repo, branch `master`.
2. Build pack **Dockerfile**. In the build settings set **Docker Build Stage Target = `api`**. Port **8080**.
   (Or use the prebuilt image `ghcr.io/thesupersupersigma/reconsumet-api:<version>` as a Docker Image resource.)
3. Domain: e.g. `https://api.example.com`. If you route your apps through a Cloudflare Tunnel, add it as a public
   hostname there the same way as your other Coolify apps, and set `CLIENT_IP_HEADER=CF-Connecting-IP`.
4. Environment variables: at least `DATABASE_URL`, `PUBLIC_URL`, `RELAY_PUBLIC_URL`, `RELAY_SECRET`,
   `TRUSTED_PROXIES` (see below).
5. Deploy. On start the API applies its database migrations (under a lock), then serves. Check
   `https://api.example.com/v1/health` and `/docs`.
6. Create the site's API key in the API container's terminal (Coolify → the app → Terminal):
   `node dist/cli.js keys create site`. The key is shown **once**. Put it in the site's env, never in browser code.

## 4. The relay (its own hostname, not through Cloudflare's proxy)

1. **DNS:** an `A` record `relay.example.com` → the server's public IP. On Cloudflare: **DNS only (grey cloud)**. This
   makes the IP visible in DNS. On a home connection whose IP changes, use a DDNS updater.
2. **Router (home server):** forward TCP **443** to `<server-lan-ip>`, where Coolify's Traefik listens. Also forward
   **80** for Let's Encrypt's HTTP challenge, unless you switch Traefik to DNS challenges. Traefik only answers
   hostnames it knows, so your other apps stay unreachable this way.
3. Coolify → **New Resource → Application**, same repo, Dockerfile build pack, **Docker Build Stage Target =
   `relay`**, port **8081**, domain `https://relay.example.com`. Coolify's Traefik requests the certificate.
4. Environment variables: `RELAY_SECRET` (same as the API), `RELAY_ALLOWED_ORIGINS` (your site's origins, e.g.
   `https://example.com`), `TRUSTED_PROXIES`, `RELAY_METRICS_TOKEN`, and `RELAY_GLOBAL_MBPS` sized to your upload
   ([../self-hosting.md](../self-hosting.md#sizing-bandwidth)).
5. Deploy and check `https://relay.example.com/health` from outside your network (e.g. a phone on mobile data).

**`TRUSTED_PROXIES`:** use the subnet of Coolify's proxy network:
`docker network inspect coolify --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'` on the server. Too wide (e.g. your
whole LAN) lets LAN devices fake their IP. Empty means every viewer looks like Traefik's address, so the per-IP limits
become one shared limit.

## Moving the relay to another machine later

Run the relay there (Coolify, or plain `docker compose up -d relay`) with the same environment, point
`relay.example.com` at the new IP (still DNS-only), set `RELAY_SHARES_EGRESS_WITH_API=false` on the API, and remove the
router's port forward. Details: [../self-hosting.md](../self-hosting.md#where-the-relay-lives).
