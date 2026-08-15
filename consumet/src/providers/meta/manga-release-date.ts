/**
 * =================================================================================================
 * CHAPTER RELEASE-DATE NORMALISATION
 * =================================================================================================
 *
 * ONE ENDPOINT WAS RETURNING TWO FORMATS IN THE SAME FIELD. `/manga/chapters` serves whichever of
 * the seven registered providers answered, and they do not agree on how to spell a date:
 *
 * Measured live 2026-08-14 over 5,993 chapter rows (see the census in the test alongside this):
 *
 *   provider      raw `releaseDate` (or MangaHere's misspelled `releasedDate`)
 *   ------------  ---------------------------------------------------------------------------
 *   MangaDex      "2023-09-05T17:14:12.000Z"        ISO instant, ms precision, Z
 *   FlameComics   "2025-02-17T16:43:07.000Z"        ISO instant, ms precision, Z (built from unix s)
 *   WeebCentral   "2024-09-07T17:04:15.717Z"        ISO instant, ms precision, Z
 *   MangaKakalot  "2025-09-20T11:03:09.000000Z"     ISO instant, SIX-digit fractional seconds
 *   AsuraScans    FIVE SHAPES AT ONCE — see below
 *   MangaHere     "Jan 09,2025"                     English month abbrev, no time, no zone
 *   MangaPill     (nothing — the field is absent on all 1,487 rows sampled)
 *
 * ASURASCANS IS THE ONE THAT SETTLES THE "IS ALREADY-ISO GOOD ENOUGH" QUESTION. Across 1,039 dated
 * chapters of six series it emitted, in one field, from one endpoint:
 *
 *   957 x "2026-03-19T06:13:09Z"            no fractional part at all
 *    42 x "2026-05-27T17:51:06.065Z"        three digits
 *    36 x "2026-08-05T16:45:52.287297Z"     six digits
 *     3 x "2026-08-12T17:00:56.65804Z"      FIVE digits — trailing zero trimmed
 *     1 x "2026-04-10T14:43:10.75Z"         TWO digits — both trailing zeros trimmed
 *
 * That is a serialiser that drops trailing zeros, so the rendering varies row to row inside a
 * SINGLE chapter list. Note the fifth shape was found by a LATER, WIDER sweep than the one that
 * wrote this module — which is exactly why the grammar below accepts any fractional-digit count
 * instead of enumerating the counts seen so far. A sixth would cost nothing.
 *
 * These renderings do not sort together: '.' is 0x2E and 'Z' is 0x5A, so
 * `"2026-08-12T17:00:56.65804Z"` sorts BEFORE `"2026-08-12T17:00:56Z"` as a string while being 658 ms
 * LATER in time (verified on those two real spellings). Be precise about the strength of that,
 * though: an inverting PAIR needs two chapters inside the same wall-clock second spelled
 * differently, and the 1,039-row sweep found none — 940 distinct seconds, zero collisions, raw
 * string-sort still equalled time-sort. So the ordering hazard is LATENT, a property of the emitted
 * format rather than a wrong order anyone has been served. What is unconditional and needs no
 * collision at all is that two spellings of the SAME instant break string equality, dedup and
 * cross-provider comparison. Canonicalisation is justified on those plus the latent inversion —
 * and it is why "already ISO" is not a reason to leave a value alone.
 *
 * -------------------------------------------------------------------------------------------------
 * THE RULE: NORMALISE WHAT IS UNAMBIGUOUS, PASS THROUGH WHAT IS NOT, NEVER GUESS.
 * -------------------------------------------------------------------------------------------------
 *
 * The previous pass declined to normalise at all, reasoning that "guessing a locale is how you
 * invent a wrong date". THAT REASONING IS CORRECT AND IS PRESERVED HERE — it is the reason
 * {@link UNKNOWN} exists and the reason the grammar below is a closed list rather than a call to
 * `new Date()`. It simply does not reach `"Jan 09,2025"`, which names its month in English and can
 * only be read one way. It does reach `03/04/2018`, where DD/MM and MM/DD are both live readings
 * and picking one invents a date; such a string is passed through untouched.
 *
 * Three things are consequently NEVER done here:
 *
 *   1. NO GUESSED TIMEZONE. `"Jan 09,2025"` carries no time and no zone. It is emitted as the
 *      calendar date `"2025-01-09"` — a complete, valid ISO 8601 / RFC 3339 `full-date` — and NOT
 *      as `"2025-01-09T00:00:00Z"`, which would assert an instant the provider never stated and
 *      would be wrong by up to a day either side for anyone east or west of UTC. For the same
 *      reason a date-TIME with no zone (`"2025-09-20T11:03:09"`, unobserved but cheap to guard) is
 *      NOT normalised: it is off by up to 26 hours depending on the zone you invent, so it is
 *      passed through as {@link UNKNOWN} instead.
 *
 *   2. NO INVENTED PRECISION. A partial date — `"2018"`, `"Nov 2018"` — is passed through. Widening
 *      it to `2018-01-01` manufactures a day and a month out of nothing, which is exactly the
 *      failure the previous pass was right to avoid. Note the converse is not invention: dropping
 *      MangaKakalot's microseconds is a real loss of precision but a harmless one (they are
 *      `000000` on every row measured, and a scanlation release is not a microsecond event), and it
 *      is forced anyway — a JS `Date` is millisecond-resolution.
 *
 *   3. NO RELIANCE ON ENGINE LENIENCY. `Date.parse` is implementation-defined for anything that is
 *      not exactly an ISO 8601 string, so `new Date("Jan 09,2025")` working in V8 is a fact about
 *      V8, not about the format. Every shape supported here is matched by an explicit regex, its
 *      civil fields are range-checked, and the result is round-tripped through `Date.UTC` so that
 *      `"Feb 30,2025"` is rejected rather than silently rolled to March 2nd. Everything else is
 *      passed through verbatim.
 *
 * -------------------------------------------------------------------------------------------------
 * A PASS-THROUGH MUST NOT LOOK LIKE A NORMALISED VALUE
 * -------------------------------------------------------------------------------------------------
 *
 * That is the whole point of the item, and this repo's recurring failure mode is "two different
 * things rendered identically". If normalisation only ever rewrote the string, a client would still
 * have to sniff it to find out whether `new Date()` is safe — the same guessing game, moved one
 * layer down. So the shape of the value is REPORTED, not implied: every normalised chapter carries
 * a {@link MangaReleaseDatePrecision} alongside the date, and the contract a consumer may rely on is
 *
 *   'instant' → an ISO 8601 UTC instant, always exactly `YYYY-MM-DDTHH:MM:SS.sssZ`. Parseable.
 *   'day'     → an ISO 8601 calendar date, always exactly `YYYY-MM-DD`. No time, no zone, because
 *               the provider stated none. Parseable, but note `new Date('2025-01-09')` reads it as
 *               UTC midnight — that is the consumer choosing a zone, and it is their choice to make.
 *   'unknown' → THE PROVIDER'S OWN STRING, VERBATIM. Not parsed, not parseable in general. Render it
 *               as text. `new Date()` on it may yield `Invalid Date` or, worse, a plausible wrong one.
 *
 * When normalisation rewrote the string, the original is kept as `raw` so the provenance is not
 * lost and a mis-parse can be diagnosed from the response alone. When nothing was rewritten (an
 * already-canonical MangaDex instant, or an 'unknown' pass-through) `raw` is absent, so its presence
 * means exactly "this differs from what the provider said".
 *
 * ONE EXACT CAVEAT ON "VERBATIM", stated rather than glossed: surrounding WHITESPACE is stripped
 * before anything else happens, and that strip alone never sets `raw`. So a pass-through is the
 * provider's string verbatim MODULO LEADING/TRAILING WHITESPACE, and `raw`'s absence means "identical
 * to upstream once trimmed". This is deliberate — a `raw` that differed from `value` only by a space
 * would be noise, and no observed provider pads the field — but it is a real narrowing of the word
 * "verbatim" and a consumer doing a byte-exact comparison against upstream should know it.
 */

/** What a consumer is holding. See the contract in this file's header. */
export type MangaReleaseDatePrecision = 'instant' | 'day' | 'unknown';

export interface INormalizedReleaseDate {
  /** Canonical when `precision` is 'instant' or 'day'; the provider's verbatim string when 'unknown'. */
  value: string;
  precision: MangaReleaseDatePrecision;
  /** The provider's original string — present ONLY when it differs from {@link value}. */
  raw?: string;
}

/**
 * ISO-8601-ish instant. Deliberately stricter than the spec in one place and looser in another:
 *
 *  - the zone designator is REQUIRED (`Z` or `±HH[:]MM`). ISO 8601 permits omitting it and means
 *    "local time"; there is no local time on a server, so an unzoned string cannot be resolved to
 *    an instant without inventing a zone. Unzoned input falls through to 'unknown' by design.
 *  - seconds are optional and the fractional part may be ANY number of digits, because the providers
 *    disagree and AsuraScans disagrees WITH ITSELF: 0, 2, 3, 5 and 6 digits all observed in one list.
 *    A fixed `\d{3}` here would have passed 957 of 1,039 AsuraScans rows straight through
 *    unnormalised — and an enumeration of the counts seen at the time would have missed the 2-digit
 *    shape a later sweep found. Accepting any count is what made that discovery a no-op.
 *  - a space is accepted in place of `T` (RFC 3339 §5.6 allows it; some scrapers emit it).
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|z|[+-]\d{2}:?\d{2})$/;

/** ISO 8601 `full-date`. Already canonical, so it is validated and passed straight back. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * MangaHere's shape, and the ONLY non-ISO shape normalised. `"Jan 09,2025"` — measured on 3,306
 * chapter rows across five series, with zero other shapes present. Written tolerantly (full month
 * names, 1-or-2-digit day, optional space after the comma) because the site's own rendering is not
 * a contract, but the MONTH MUST BE NAMED: that is precisely what makes it unambiguous, and it is
 * why `03/04/2018` has no rule here and never will.
 */
const NAMED_MONTH_DAY_YEAR = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*,\s*(\d{4})$/;

const MONTHS: ReadonlyMap<string, number> = new Map([
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * True when (y, m, d) is a real calendar date. Done by round-tripping through `Date.UTC` rather
 * than by a leap-year branch, because `Date.UTC` rolls overflow forward silently — `Feb 30` becomes
 * `Mar 2` — so "did the fields survive the trip" IS the validity test, and it gets leap years right
 * for free. Years are constrained to 1000..9999 so a four-digit match cannot be a truncated garbage
 * token, and note `Date.UTC` maps years 0..99 to 1900+y, which this range also sidesteps.
 */
const isRealDate = (y: number, m: number, d: number): boolean => {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
};

/** `.7` → 700ms, `.000000` → 0ms, `.71828` → 718ms. Truncates, never rounds: a release date must not move forward. */
const fractionToMillis = (frac: string | undefined): number => {
  if (!frac) return 0;
  return Number(frac.slice(0, 3).padEnd(3, '0'));
};

const parseInstant = (input: string): string | undefined => {
  const m = ISO_INSTANT.exec(input);
  if (!m) return undefined;
  const [, ys, ms_, ds, hs, mins, ss, frac, zone] = m;
  const y = Number(ys), mo = Number(ms_), d = Number(ds);
  const h = Number(hs), mi = Number(mins), s = ss === undefined ? 0 : Number(ss);
  // Range-check the civil fields BEFORE applying the offset — the offset may legitimately shift the
  // date across a day boundary, so validating after it would reject correct input near midnight.
  if (!isRealDate(y, mo, d)) return undefined;
  // 24:00:00 is legal ISO 8601 for end-of-day and 60 is a leap second; both would roll over in
  // `Date.UTC` into a DIFFERENT instant than the one written, so neither is accepted. No provider
  // emits either, and passing them through untouched is more honest than silently shifting them.
  if (h > 23 || mi > 59 || s > 59) return undefined;

  let epochMs = Date.UTC(y, mo - 1, d, h, mi, s, fractionToMillis(frac));

  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const offH = Number(zone.slice(1, 3));
    const offM = Number(zone.slice(-2));
    if (offH > 23 || offM > 59) return undefined;
    epochMs -= sign * (offH * 60 + offM) * 60_000;
  }

  if (!Number.isFinite(epochMs)) return undefined;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return undefined;
  // `toISOString()` throws (RangeError) outside ±8.64e15 ms; the 1000..9999 year clamp above keeps
  // us far inside that, so this is total.
  return date.toISOString();
};

const parseIsoDate = (input: string): string | undefined => {
  const m = ISO_DATE.exec(input);
  if (!m) return undefined;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return isRealDate(y, mo, d) ? `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}` : undefined;
};

const parseNamedMonthDate = (input: string): string | undefined => {
  const m = NAMED_MONTH_DAY_YEAR.exec(input);
  if (!m) return undefined;
  const mo = MONTHS.get(m[1].toLowerCase());
  if (mo === undefined) return undefined; // an unrecognised word is not a month; pass the string through
  const d = Number(m[2]), y = Number(m[3]);
  return isRealDate(y, mo, d) ? `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}` : undefined;
};

/**
 * The one entry point. Total: any input, including `null`/`undefined`/objects/`NaN`, yields either
 * a well-formed {@link INormalizedReleaseDate} or `undefined` (meaning "there was no date here at
 * all", which is MangaPill's permanent state). It never throws, and it never drops a value it
 * failed to understand — an unrecognised string comes back verbatim, flagged 'unknown'.
 */
export const normalizeReleaseDate = (input: unknown): INormalizedReleaseDate | undefined => {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  const instant = parseInstant(trimmed);
  if (instant !== undefined)
    return instant === trimmed
      ? { value: instant, precision: 'instant' }
      : { value: instant, precision: 'instant', raw: trimmed };

  const isoDay = parseIsoDate(trimmed);
  if (isoDay !== undefined) return { value: isoDay, precision: 'day' }; // already canonical; no `raw`

  const namedDay = parseNamedMonthDate(trimmed);
  if (namedDay !== undefined) return { value: namedDay, precision: 'day', raw: trimmed };

  // Everything else — relative ("2 days ago", "Today"), partial ("2018", "Nov 2018"),
  // locale-ambiguous ("03/04/2018"), or outright junk. Verbatim, and honestly labelled.
  return { value: trimmed, precision: 'unknown' };
};
