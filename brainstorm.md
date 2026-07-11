# RECONSUMET-TS Multi-Server Exposure — Brainstorm & Design Doc

> Right now, RECONSUMET-TS's healthy providers (AniNeko, AnikotoTV) each discover
> multiple real servers per episode/audio-type on their source site, then throw
> all but one away before returning to the API. This doc is about changing that:
> keep auto-picking a sensible default server to play, but stop discarding the
> rest — surface them as selectable alternatives in the site's server menu.
>
> This doc is a living record. Nothing gets deleted — ideas move between
> sections as decisions get made. Add a date when you move something.

Last updated: 2026-07-11

---

## 0. The Core Framing (read this first)

RECONSUMET-TS scrapes anime source sites for streamable video. Each source site
(AniNeko, AnikotoTV, etc.) typically offers several servers per episode per
audio type (e.g. HD-1, VidCloud, Kiwi-Stream, StreamHG, Earnvids) — different
CDNs mirroring the same content, useful as fallbacks when one is slow/down/geo-
blocked. Today, the scraper's provider code finds all of them internally, then
picks exactly one (`HD-1`/VibePlayer where available) and discards the rest —
so the site only ever sees 1 server per provider per audio type, even when the
source site itself is offering several.

The core design tension: this is a real API-shape change (the `/watch` response
needs to carry multiple servers instead of one), which means both the scraper
(RECONSUMET-TS) and the main site (`route.ts`, the server-selection UI) need
coordinated updates. It's not a scraper-only fix.

The desired end state, stated plainly: **auto-play a sensible default server
(same behavior as today), but expose every other working server the site
found as a selectable option in the server dropdown** — nothing is thrown away
anymore, it's just not the default choice.

---

## 1. Accepted Decisions

### 1.1 What "fix" means here
**Decision: Keep auto-selecting a default/preferred server to autoplay (current
behavior), but stop discarding the other discovered servers — return all of
them so the site can list them as user-selectable alternatives.**
- This is not "replace the best-server heuristic with something else" — the
  existing preference logic (e.g. `HD-1`/VibePlayer preferred) stays as the
  *default* selection; it's the *only* option today, and after this change it
  becomes *one option among several*.
- Confirmed directly with Super on 2026-07-11.

### 1.2 Root cause is original design, not a regression
**Decision: This is not something to "fix" as a bug — it was never built to
return multiple servers.** `fetchEpisodeSources` on both `AnikotoTV` and
`AniNeko` was written with a `Promise<ISource>` (singular) return type from
the start. Confirmed via git history during the RECONSUMET-TS audit session
(2026-07-11) — no commit ever removed multi-server support; it never existed.

### 1.3 AnimeUnity's role
**Decision: AnimeUnity stays categorized as an intentional fallback, not a
primary provider needing equal priority.** It's an Italian source site with no
English captions on the host itself — English subs come from an external
subtitle layer. Confirmed in the aggregator's own code comment during the audit.

### 1.4 First-pass scope: AniNeko + AnikotoTV only
**Decision: Build multi-server support for AniNeko and AnikotoTV first** (the
two confirmed-healthy providers), **then confirm AnimeNoSub and ReAnime are
actually healthy, then wire multi-server support into those too** as a
follow-up pass.
- Reasoning (Super, 2026-07-11): no point building fan-out plumbing for
  providers we haven't even confirmed are alive. Confirm health first,
  extend second.
- ReAnime's video path was just restored (proxy/TLS-impersonation fix,
  earlier session) but hasn't had a dedicated health-confirmation pass yet.
  AnimeNoSub's health was never directly confirmed — flagged as a suspect
  in the original "servers regressed" finding but not diagnosed with the
  same rigor as AniNeko/AnikotoTV.

### 1.5 AnimeUnity deprioritized for multi-server work
**Decision: Skip AnimeUnity for now; revisit last, only if cheap.**
- Reasoning (Super, 2026-07-11): it's already a fallback-only source (see
  1.3), so it's lowest-value to extend right now. Not rejected outright —
  if the AniNeko/AnikotoTV plumbing turns out to generalize easily, it can
  be added later with little extra cost. But it shouldn't be scheduled or
  prioritized ahead of the two reliable providers, or ahead of confirming
  AnimeNoSub/ReAnime's health.

### 1.6 ReAnime episodeId-mismatch fix — owned by the site chat
**Decision: The ReAnime episodeId-mismatch bug (see 2, below) gets fixed in
the "Site bug fixes and feature freeze" project chat, not here.**
- Reasoning (Super, 2026-07-11): it's a `route.ts` bug, and `route.ts` work
  has consistently lived in that chat. Keeps ownership consistent.

### 1.7 Site-side `route.ts` update for multi-server — written here
**Decision: The site-side change needed to consume multiple servers per
provider/type (instead of assuming one) gets written in THIS session,
alongside the scraper-side change — not handed off separately.**
- Reasoning: this is a coupled API-contract change. If the scraper starts
  returning arrays of servers and `route.ts` isn't updated to match at the
  same time, the site either breaks on the new shape or silently only reads
  the first server in the array — either way the whole point of the fix is
  lost. Shipping them out of sync isn't safe here the way the ReAnime
  episodeId bug (1.6) is — that one is independent and can be fixed on its
  own schedule; this one can't.

---

## 2. Under Consideration

- **Wiring AnimeNoSub/ReAnime into multi-server support** — deferred until
  their health is confirmed (see 1.4). Not rejected, just not yet — revisit
  once each is confirmed working.
- **AnimeUnity multi-server support** — deliberately deprioritized, see 1.5.
  Revisit last, after everything else is done, only if it turns out to be
  easy/cheap once the AniNeko/AnikotoTV plumbing exists as a template.

---

## 3. Rejected Ideas

*(none yet)*

---

## 4. Open Questions

*(none currently open — Q1–Q3 from the previous round were all resolved this
round; see 1.4–1.7)*

---

## 5. Change Log

- **2026-07-11**: Doc created. Logged the core framing, the "keep a default +
  expose the rest as options" decision, the original-design (not regression)
  finding, the AnimeUnity-is-fallback confirmation, and the newly-discovered
  ReAnime episodeId-mismatch bug as an open item. Three open questions raised
  for Super.
- **2026-07-11** (same day, follow-up): Super answered all three open
  questions. Logged as 1.4 (AniNeko + AnikotoTV first, confirm others'
  health before extending), 1.5 (AnimeUnity deprioritized, revisit last),
  1.6 (ReAnime episodeId bug → site chat), 1.7 (multi-server `route.ts`
  update → written here, coupled to the scraper change). Ready to move from
  brainstorming into writing the actual fix prompts.
- **2026-07-11** (same day, second follow-up): Corrected a tooling mistake —
  the doc was initially written with the wrong tool and landed in Claude's
  own sandbox instead of this repo. Re-written here with the correct tool
  (desktop-commander/filesystem, which reach the real Mac). Content
  unchanged, just actually in the right place now.
