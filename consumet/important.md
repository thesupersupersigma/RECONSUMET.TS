# 👋 START HERE (session 3 handoff)

Read this, then reopen the saved Claude chat and say "let's continue."

## 🔑 Saved Claude chat
```
CHAT ID:  __________________________________________   (paste this session's id)
FULL CMD: claude --resume <id> --dangerously-skip-permissions
```
(If gone: a fresh Claude reads `CLAUDE.md` in this folder + my memory and picks up.)

## 📍 Where we left off (big progress)
The whole pipeline is built and working **except the last-mile video fetch**:
- ✅ **AniList aggregator** — search one title, get it mapped across providers (Gogoanime + AnimeUnity), with fallback.
- ✅ **Fastify API** (`api/`) — `/search`, `/info/:id`, `/episodes/:id`, `/watch`. Run: `cd api && pnpm start` (needs cloakbrowser for episode lists).
- ✅ **Stream proxy** (`/proxy`) — injects the Referer + rewrites HLS + CORS.
- ⚠️ **THE BLOCKER:** the megaplay video CDN (cdn.mewstream.buzz etc.) is behind Cloudflare that gates on **TLS fingerprint** — a real browser gets the video (200), but any server fetch (Node/curl) gets **403**. Cookie-harvesting does NOT help (no cookie; it's the TLS handshake).
- 🐍 **The fix = ViperTLS** (your suggestion!) — installed in `.venv-tls/`. It impersonates a browser's TLS so the proxy can fetch the gated CDN server-side. **Validation is PENDING** — its first call hung (probably warming its bundled browser under low RAM). Needs a clean retry next session.

## ✅ Your steps next session (quick)
1. Free RAM first (see below) — you're on 8GB and this stack is heavy.
2. Start cloakbrowser: `docker start cloak` (or the run cmd if gone:
   `docker run -d --name cloak -p 127.0.0.1:9222:9222 cloakhq/cloakbrowser cloakserve`)
3. Tell me "let's continue" — I'll **validate ViperTLS against the gated m3u8**, and if it works, wire the proxy to fetch the CDN through it. That's the final piece for real playback.

## 🧠 RAM management (you have 8GB; this stack is heavy)
- **Docker Desktop → Settings → Resources → Memory → ~2GB** (caps cloakbrowser).
- **`docker stop cloak` when not testing** — it's the biggest consumer (full Chromium).
- ViperTLS bundles its own headless browser (in `vipertls/`) — only runs when solving; can be heavy.
- I now stop my background node/test processes each time; ask me to clean up if your RAM spikes.

## 🧱 What works right now (no action needed)
- Providers: **Gogoanime** (cloakbrowser + megaplay, English subs, full episode lists) + **AnimeUnity** (browser-free, no subs).
- `AnimeAggregator` + the Fastify API (search/info/episodes resolve fine; `/watch` returns URLs that play in a real browser but not yet via the server proxy — pending ViperTLS).
- Git: 3 milestone commits on `master`. I commit after each milestone.

## ⚠️ Reminders
- Don't bother with AnimePahe (hard JWE/ad gate) or the dead sites.
- Rebrand away from "consumet" before going public (license allows it; reduces takedowns).
- Goal: host the API on your Oracle VM (ARM, lots of RAM) behind Cloudflare.

---
*Full technical brief for Claude is in `CLAUDE.md`. See you in a few hours! 🚀*
