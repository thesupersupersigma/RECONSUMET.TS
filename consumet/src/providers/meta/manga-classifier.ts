import { compareTwoStrings } from '../../utils/utils';
import type { IMangaMatchClassifier, IMangaMeta, MangaMatchConfidence } from './manga-aggregator';

// ---------------------------------------------------------------------------------------------
// THE CONFIDENCE CLASSIFIER — tier 2 ('metadata') and the honest labelling of tier 3.
//
// WHAT THIS REPLACES, AND WHY IT IS NOT AN EPISODE-COUNT PORT.
//
// `AnimeAggregator.verifyMatch` proves a match three ways: a leaked AniList id, a season-ordinal
// contradiction, and EPISODE_COUNT_TOLERANCE (+/-3 episodes). On the manga side:
//   * the id check is B2's job (MangaDex `links.al`, MAL-Sync) and produces 'exact-id' outright,
//   * seasons do not exist,
//   * and the count backstop HAS NO PORT. AniList returns `chapters: null` AND `volumes: null` for
//     every RELEASING series — re-confirmed live 2026-08-14 against manga id 30013 (One Piece,
//     status RELEASING, chapters null, volumes null) — so a count check is absent exactly where
//     wrong-match risk is highest. Even where a count exists the providers disagree structurally:
//     split chapters, decimal numbering (100.5), per-language feeds with different totals, and
//     "Official Colored" re-releases carried as separate series with their own counts.
//
// SO THE COUNTS ARE DELIBERATELY NOT READ, EVEN THOUGH THEY ARE SITTING RIGHT THERE. MangaDex's
// search result carries `lastChapter`/`lastVolume`, AsuraScans' carries `chapterCount` and
// `latestChapter`, FlameComics' info carries a chapter array. Comparing any of them to
// `IMangaMeta.chapters` would produce a number that LOOKS like verification and is nothing of the
// sort: for the RELEASING series where a wrong match hurts most it can only ever compare against
// `undefined`, and for the FINISHED ones it fires on exactly the re-releases it is supposed to
// separate (a colour edition of a 201-chapter manhwa has 201 chapters too). A confident wrong
// answer is worse than an honest 'unverified', so no chapter/volume field is read anywhere below.
//
// WHAT IS READ INSTEAD: signals that carry information the title does not, and that a re-release,
// a sequel or a novelisation actually differs on.
//
//   * START YEAR — the single most discriminating field a manga provider publishes. Live
//     2026-08-14: MangaDex has "One Piece" year=1997 and "One Piece (Official Colored)" year=2012;
//     FlameComics has "Solo Leveling" 2018 and "Solo Leveling: Ragnarok" 2024. AniList's
//     startYear for those two series is 1997 and 2018. The year separates all four.
//   * THE MANGA / MANHWA / MANHUA AXIS — `type` (AsuraScans "manhwa", FlameComics "Manhwa") or a
//     genre/tag list, matched against AniList `countryOfOrigin` (JP / KR / CN / TW). 'manhua' is
//     mapped to {CN, TW} rather than to one of them, because MangaDex's own `originalLanguage`
//     collapses both to 'zh' and nothing downstream can tell them apart (this is the same reason
//     ./manga-metadata.ts refuses to backfill countryOfOrigin).
//   * THE COMIC / NOVEL AXIS — veto only, never a signal. See NOVEL_MARKER below.
//
// TWO SIGNALS IS ALL THERE IS, AND THE COUNTING IS PER PROVIDER FIELD, NOT PER DERIVED FACT.
// `type: "manhwa"` implies both "Korean" and "not a novel"; counting that as two would be counting
// one field twice. So a candidate has at most two independent corroborations available today
// (`year`, `type`), which is why the promotion rules below ask for so few — asking for three would
// make 'metadata' unreachable rather than rigorous.
//
// THE SIGNAL DELIBERATELY NOT ADDED: AUTHOR. WeebCentral's search cards carry `authors`, and author
// equality is very nearly as strong as an id. It is not used because (a) `IMangaMeta` does not
// carry staff and adding it widens the AniList query on every single resolve for one provider's
// benefit, and (b) author names cross romanisation and name-order boundaries ("Oda Eiichiro" /
// "Eiichiro Oda" / "尾田栄一郎"), so a naive string comparison would MISS the true matches and a
// token-set comparison would need its own evidence base. It is the obvious next signal; it is
// documented here rather than half-implemented.
//
// EVERY VETO IS SAFE BY CONSTRUCTION. The worst a veto can do is leave a correct match labelled
// 'unverified' — which is what B1 already did for everything, and which is served either way. The
// worst a missing veto can do is stamp 'metadata' on the light novel. So the rules below are
// deliberately asymmetric: cheap, broad vetoes; narrow, evidence-backed promotions.
// ---------------------------------------------------------------------------------------------

/**
 * Similarity the provider's PRIMARY title must reach before two corroborating signals are even
 * considered (see path B in {@link MetadataMatchClassifier.explain}). Far above the aggregator's
 * own TITLE_FLOOR of 0.35, which exists only to decide what is worth fetching.
 */
const NEAR_EXACT_TITLE = 0.85;

/**
 * Years two databases may disagree by and still be talking about the same series. 1, not 3:
 * serialisation start dates drift by a magazine issue (issues are cover-dated ahead of print) or
 * by a region-of-first-release, and that is a one-year effect. Two years is a different series
 * often enough to matter — "Solo Leveling" 2018 vs "Solo Leveling: Ragnarok" 2024 is the easy case,
 * but colour re-releases land 2-15 years after the base record and a wide tolerance would start
 * waving those through.
 */
const YEAR_TOLERANCE = 1;

/**
 * Re-release / derivative markers. Superset of ./manga-xref.ts's VARIANT_MARKER (which tie-breaks
 * MAL-Sync's multi-record sites) — this one also has to survive provider titles rather than
 * MAL-Sync's, and those add `fanbook`/`databook`/`artbook` and bare `(Volume)`.
 *
 * Only ever a VETO, and only when NO AniList title carries the same marker — a request for the
 * colour edition itself must still be able to reach the colour edition.
 */
const RERELEASE_MARKER =
  /\b(colou?red|full[\s-]?colou?rs?|digital(?:ly)?[\s-]?colou?red|fan[\s-]?colou?red|official\s+volume|volume\s+(?:version|edition)|book\s+version|remake|reprint|anthology|doujin\w*|fan[\s-]?book|data[\s-]?book|art[\s-]?book|guide[\s-]?book|pre-?serial\w*)\b/i;

/**
 * Novelisation markers. Kept separate from RERELEASE_MARKER because the exemption is different: a
 * "(Novel)" title is correct when AniList itself says `format: NOVEL`.
 *
 * This is the rule that answers the measured MangaPill failure. Live 2026-08-14,
 * `MangaPill.search('Solo Leveling')` returns, in order: "Solo Leveling Novel"
 * (alt "Solo Leveling Official Light Novel"), "Solo Leveling: Ragnarok Novel", "Solo Glitch
 * Player", ... — the manhwa is not in the top five at all. AniList 105398 is `format: MANGA`, so
 * the top hit is vetoed here and stays 'unverified'. It is still SERVED; it is just not dressed up.
 */
const NOVEL_MARKER = /\b(light[\s-]?novels?|web[\s-]?novels?|novels?|novelisation|novelization)\b/i;

/** A bracketed qualifier: "(Official Colored)", "(Volume)", "(Doujinshi)", "[Colored]". */
const BRACKETED_QUALIFIER = /[([{（【［]([^)\]}）】］]{1,60})[)\]}）】］]/g;

/** Words in a provider's `type`/genre text that assert an origin, mapped to AniList countryOfOrigin. */
const ORIGIN_WORDS: readonly { readonly re: RegExp; readonly countries: readonly string[]; readonly label: string }[] = [
  { re: /\bmanhwa\b|\bkorean\b|\bwebtoon\b/i, countries: ['KR'], label: 'manhwa/Korean' },
  // 'zh' is CN or TW with no way to tell which — agreeing with both is the honest reading.
  { re: /\bmanhua\b|\bchinese\b|\btaiwanese\b/i, countries: ['CN', 'TW'], label: 'manhua/Chinese' },
  { re: /\bmanga\b|\bjapanese\b/i, countries: ['JP'], label: 'manga/Japanese' },
];

/** Words asserting the thing is a comic rather than prose. */
const COMIC_WORDS = /\b(manga|manhwa|manhua|comic|webtoon|doujinshi|one[\s-]?shot|oneshot)\b/i;

/** Provider fields that have ever carried a series year in this repo's six providers. */
const YEAR_KEYS = ['releaseDate', 'releasedDate', 'year', 'startYear', 'released'] as const;

/** Provider fields that have ever carried a work type. `genres`/`tags` are scanned as text. */
const TYPE_KEYS = ['type', 'format', 'genres', 'tags', 'categories'] as const;

// =============================================================================================
// SMALL, TOTAL HELPERS
// =============================================================================================

/**
 * Fold a title to its comparable form: NFKC, lowercase, every non-letter/non-digit run collapsed to
 * one space. That is what makes "Na Honjaman Level-Up" (MangaDex's primary title for Solo Leveling)
 * equal to AniList's romaji "Na Honjaman Level Up" — a pair no fuzzy threshold should have to be
 * tuned for.
 */
export const normalizeTitle = (value: unknown): string =>
  typeof value !== 'string'
    ? ''
    : value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

/** Every bracketed qualifier in a title, normalised. */
const bracketedQualifiers = (title: string): string[] => {
  const out: string[] = [];
  // A fresh RegExp each call: BRACKETED_QUALIFIER is /g and lastIndex is stateful.
  const re = new RegExp(BRACKETED_QUALIFIER.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(title)) !== null) {
    const q = normalizeTitle(m[1]);
    if (q) out.push(q);
  }
  return out;
};

/**
 * A four-digit year out of whatever the provider put in its year-ish field. Handles MangaDex's
 * number (1997), WeebCentral's string ("2018") and an ISO date ("2018-07-25").
 *
 * KNOWN IMPRECISION, stated rather than hidden: `releaseDate` on some providers is the LATEST
 * CHAPTER's date rather than the series start. When that happens the year disagrees and the
 * candidate is demoted to 'unverified' — the safe direction. It can never promote anything.
 */
const readYear = (raw: any): number | undefined => {
  for (const key of YEAR_KEYS) {
    const v = raw?.[key];
    if (v === null || v === undefined || typeof v === 'object') continue;
    const m = String(v).match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
    if (m) return Number(m[1]);
  }
  return undefined;
};

/** The provider's type/genre text, flattened to one lowercase string. '' when it states nothing. */
const readTypeText = (raw: any): string => {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim() !== '') parts.push(v.trim());
  };
  for (const key of TYPE_KEYS) {
    const v = raw?.[key];
    if (Array.isArray(v)) for (const item of v) push(item);
    else push(v);
  }
  return parts.join(' ').toLowerCase();
};

const usableTitles = (meta: IMangaMeta): string[] =>
  (Array.isArray(meta?.titles) ? meta.titles : []).filter((t): t is string => typeof t === 'string' && t.trim() !== '');

// =============================================================================================
// EXPLANATION TYPES
// =============================================================================================

/** Which PROVIDER FIELD a signal or veto came from. One entry per field — never per derived fact. */
export type MangaMatchField = 'title' | 'year' | 'type';

export interface IMangaMatchNote {
  field: MangaMatchField;
  /** Human-readable, and written to be pasted into a bug report verbatim. */
  detail: string;
}

/**
 * The full reasoning behind one verdict. `classify` returns only the confidence, because that is
 * all {@link IMangaMatchClassifier} promises; this is the same computation with its working shown,
 * for diagnostics endpoints and for tests that need to assert WHY rather than just WHAT.
 */
export interface IMangaMatchExplanation {
  confidence: MangaMatchConfidence;
  /** The rule that fired, in words. */
  rule: string;
  /** Similarity of the provider's PRIMARY title against the best AniList title. */
  primaryScore: number;
  /** True when a normalised AniList title equals the provider's normalised PRIMARY title. */
  exactPrimaryTitle: boolean;
  signals: IMangaMatchNote[];
  vetoes: IMangaMatchNote[];
}

export interface IMangaMatchCandidate {
  provider: string;
  id: string;
  title: string;
  score: number;
  raw: any;
}

// =============================================================================================
// THE CLASSIFIER
// =============================================================================================

export interface IMetadataMatchClassifierOptions {
  /** See {@link NEAR_EXACT_TITLE}. */
  nearExactTitle?: number;
  /** See {@link YEAR_TOLERANCE}. */
  yearTolerance?: number;
  /**
   * Warn when a candidate scoring at least this on its primary title is vetoed. Default 0.9.
   * The interesting diagnostic is "this looked like a perfect title match and was deliberately NOT
   * promoted, here is what disagreed" — low volume, and the only way a mis-tuned veto surfaces.
   * Set to Infinity to silence.
   */
  warnVetoAbove?: number;
}

/**
 * Tier 2. Promotes 'unverified' to 'metadata' only on title EQUALITY plus corroboration, or
 * near-equality plus double corroboration — and never over a contradiction.
 *
 * IT CANNOT RETURN 'exact-id'. That tier means "an id bridge named this provider id outright", and
 * no amount of agreeing metadata is an id. `MangaAggregator.rankedFor` does not even call a
 * classifier for a bridged provider — the bridge returns before the search is issued — so the two
 * tiers cannot collide.
 *
 * WHY EQUALITY IS AGAINST THE PROVIDER'S *PRIMARY* TITLE ONLY, WHILE THE AGGREGATOR'S RANKING
 * SCORE USES ALT TITLES TOO. Provider alt-title lists are franchise lists, not synonym lists.
 * Captured live 2026-08-14: AsuraScans' record for the base "Solo Leveling" carries
 * "Solo Leveling: Arise" among its 29 alt titles — a DIFFERENT series (MangaDex 83ff1ad8, no
 * `links.al`). Allowing an alt-title equality to promote would therefore stamp 'metadata' on the
 * base manhwa when the caller asked for Arise. The AniList side is the opposite case and IS
 * trusted: its titles are romaji/english/native plus synonyms, and ./manga-metadata.ts only ever
 * appends alt titles taken from the one MangaDex record that asserts this exact AniList id — by
 * construction titles OF this series. So: any AniList title, but only the provider's headline one.
 * Alt titles keep doing what they were added for — getting the candidate ranked at all.
 */
export class MetadataMatchClassifier implements IMangaMatchClassifier {
  private readonly nearExactTitle: number;
  private readonly yearTolerance: number;
  private readonly warnVetoAbove: number;

  constructor(options: IMetadataMatchClassifierOptions = {}) {
    this.nearExactTitle = options.nearExactTitle ?? NEAR_EXACT_TITLE;
    this.yearTolerance = options.yearTolerance ?? YEAR_TOLERANCE;
    this.warnVetoAbove = options.warnVetoAbove ?? 0.9;
  }

  /**
   * The {@link IMangaMatchClassifier} entry point. Thin wrapper over {@link explain}.
   *
   * NOTE ON THE SAFETY PROPERTY THIS MUST NOT WEAKEN: `MangaAggregator.rankedFor` wraps this call
   * in try/catch and labels the candidate 'unverified' when it throws, so a bug here can never
   * manufacture confidence. This method therefore does NOT swallow its own errors — doing so would
   * move the failure inside the classifier where it could return a value, and the whole point is
   * that the failure path has no way to reach 'metadata'.
   */
  classify = (candidate: IMangaMatchCandidate, meta: IMangaMeta): MangaMatchConfidence => {
    const explanation = this.explain(candidate, meta);
    if (explanation.vetoes.length > 0 && explanation.primaryScore >= this.warnVetoAbove)
      console.warn(
        `[manga-classifier] ${candidate.provider} candidate "${candidate.title}" (${candidate.id}) scored ` +
          `${explanation.primaryScore.toFixed(2)} on title for AniList manga id ${meta.anilistId} but was NOT ` +
          `promoted — ${explanation.vetoes.map(v => `${v.field}: ${v.detail}`).join('; ')}. Serving it as ` +
          `'unverified' is the intended outcome, not a failure.`
      );
    return explanation.confidence;
  };

  /** {@link classify} with its working shown. Pure — no logging, no I/O. */
  explain = (candidate: IMangaMatchCandidate, meta: IMangaMeta): IMangaMatchExplanation => {
    const titles = usableTitles(meta);
    const primary = typeof candidate?.title === 'string' ? candidate.title : '';
    const normPrimary = normalizeTitle(primary);
    const signals: IMangaMatchNote[] = [];
    const vetoes: IMangaMatchNote[] = [];

    if (titles.length === 0 || normPrimary === '')
      return {
        confidence: 'unverified',
        rule: 'nothing to compare — no AniList titles or no provider title',
        primaryScore: 0,
        exactPrimaryTitle: false,
        signals,
        vetoes,
      };

    let primaryScore = 0;
    let exactPrimaryTitle = false;
    for (const mine of titles) {
      const norm = normalizeTitle(mine);
      if (norm === '') continue;
      if (norm === normPrimary) exactPrimaryTitle = true;
      const s = compareTwoStrings(norm, normPrimary);
      if (s > primaryScore) primaryScore = s;
    }

    // --- TITLE VETOES ------------------------------------------------------------------------
    // Each is "the provider said something about this record that no AniList title says", i.e. the
    // provider is distinguishing this record from something — and the thing it is distinguishing
    // it from is what we actually asked for.

    // (1) A bracketed qualifier is exactly how providers separate editions of one series:
    //     "(Official Colored)", "(Volume)", "(Doujinshi)". Captured live 2026-08-14 —
    //     WeebCentral's search for "Solo Leveling" returns "Solo Leveling" AND
    //     "Solo Leveling (Volume)", BOTH with releaseDate "2018" and status Completed. The year
    //     signal cannot separate those two; only the qualifier can. Broad on purpose: the cost of
    //     over-firing is an honest 'unverified' on a correct match.
    const metaNormalised = titles.map(normalizeTitle);
    for (const qualifier of bracketedQualifiers(primary))
      if (!metaNormalised.some(t => t.includes(qualifier)))
        vetoes.push({
          field: 'title',
          detail:
            `provider title carries the qualifier "${qualifier}", which no AniList title carries — ` +
            `providers use bracketed qualifiers to separate editions of one series`,
        });

    // (2) An unbracketed re-release marker ("One Piece Digital Colored Comics").
    if (RERELEASE_MARKER.test(primary) && !titles.some(t => RERELEASE_MARKER.test(t)))
      vetoes.push({
        field: 'title',
        detail: `provider title reads as a re-release/derivative edition and no AniList title does`,
      });

    // (3) A novelisation, when AniList says this is not one. The measured MangaPill case.
    if (NOVEL_MARKER.test(primary) && meta.format !== 'NOVEL' && !titles.some(t => NOVEL_MARKER.test(t)))
      vetoes.push({
        field: 'title',
        detail:
          `provider title reads as a novel/light novel but AniList reports format ` +
          `${meta.format ?? 'unknown'} — this is the light-novel-vs-manhwa confusion, not a match`,
      });

    // --- YEAR --------------------------------------------------------------------------------
    const year = readYear(candidate?.raw);
    if (year !== undefined && typeof meta.startYear === 'number') {
      const delta = Math.abs(year - meta.startYear);
      if (delta <= this.yearTolerance)
        signals.push({ field: 'year', detail: `provider year ${year} vs AniList startYear ${meta.startYear}` });
      else
        vetoes.push({
          field: 'year',
          detail: `provider year ${year} vs AniList startYear ${meta.startYear} (${delta} years apart)`,
        });
    }

    // --- TYPE (origin axis, and the comic/novel axis as a veto only) --------------------------
    const typeText = readTypeText(candidate?.raw);
    if (typeText !== '') {
      const saysComic = COMIC_WORDS.test(typeText);
      const saysNovel = NOVEL_MARKER.test(typeText);
      // The comic/novel axis NEVER produces a signal. "This provider record is a comic and AniList
      // says MANGA" is true of essentially every candidate on every one of these six sites, so
      // counting it would inflate the signal count with ~zero information. It is a veto only.
      if (saysNovel && !saysComic && meta.format !== undefined && meta.format !== 'NOVEL')
        vetoes.push({
          field: 'type',
          detail: `provider type "${typeText}" is prose but AniList reports format ${meta.format}`,
        });
      if (saysComic && !saysNovel && meta.format === 'NOVEL')
        vetoes.push({
          field: 'type',
          detail: `provider type "${typeText}" is a comic but AniList reports format NOVEL`,
        });

      const matched = ORIGIN_WORDS.filter(w => w.re.test(typeText));
      if (matched.length > 0 && typeof meta.countryOfOrigin === 'string' && meta.countryOfOrigin !== '') {
        const countries = matched.flatMap(w => [...w.countries]);
        const labels = matched.map(w => w.label).join(' + ');
        if (countries.includes(meta.countryOfOrigin))
          signals.push({
            field: 'type',
            detail: `provider type says ${labels}, matching AniList countryOfOrigin ${meta.countryOfOrigin}`,
          });
        else
          vetoes.push({
            field: 'type',
            detail:
              `provider type says ${labels} (${countries.join('/')}) but AniList countryOfOrigin is ` +
              `${meta.countryOfOrigin} — wrong side of the manga/manhwa/manhua axis`,
          });
      }
    }

    // --- VERDICT -----------------------------------------------------------------------------
    if (vetoes.length > 0)
      return {
        confidence: 'unverified',
        rule: `vetoed by ${vetoes.length} contradiction(s) — a contradiction is never outvoted by agreement`,
        primaryScore,
        exactPrimaryTitle,
        signals,
        vetoes,
      };

    if (exactPrimaryTitle && signals.length >= 1)
      return {
        confidence: 'metadata',
        rule:
          `exact primary-title equality plus ${signals.length} corroborating signal(s) ` +
          `(${signals.map(s => s.field).join(', ')})`,
        primaryScore,
        exactPrimaryTitle,
        signals,
        vetoes,
      };

    if (primaryScore >= this.nearExactTitle && signals.length >= 2)
      return {
        confidence: 'metadata',
        rule: `primary title ${primaryScore.toFixed(2)} >= ${this.nearExactTitle} plus two independent signals`,
        primaryScore,
        exactPrimaryTitle,
        signals,
        vetoes,
      };

    return {
      confidence: 'unverified',
      rule: exactPrimaryTitle
        ? 'exact primary-title equality, but the provider states NO corroborating field — title ' +
          'similarity alone is tier 3 by definition'
        : `primary title ${primaryScore.toFixed(2)} with ${signals.length} signal(s) — short of both ` +
          `promotion rules`,
      primaryScore,
      exactPrimaryTitle,
      signals,
      vetoes,
    };
  };
}

/** The default classifier `MangaAggregator` installs when the caller injects none. */
export const createMangaMatchClassifier = (options: IMetadataMatchClassifierOptions = {}): MetadataMatchClassifier =>
  new MetadataMatchClassifier(options);

// =============================================================================================
// DIAGNOSTICS / DOCUMENTATION
// =============================================================================================

/**
 * What each registered provider can ACTUALLY corroborate with, measured from a live search response
 * on 2026-08-14 — not from what the site theoretically stores.
 *
 * This table is the point of the whole exercise: it says, per provider, whether tier 2 is reachable
 * at all. A provider with no non-title field can only ever be 'unverified' unless an id bridge
 * covers it, and MangaPill has neither — which is exactly why its light-novel top hit for
 * "Solo Leveling" stays labelled.
 */
export const MANGA_CLASSIFIER_SIGNAL_COVERAGE: readonly {
  readonly provider: string;
  readonly year: boolean;
  readonly type: boolean;
  readonly note: string;
}[] = [
  {
    provider: 'MangaDex',
    year: true,
    type: false,
    note:
      "search() maps `releaseDate: attributes.year` (1997 for One Piece, 2012 for One Piece " +
      '(Official Colored)) and emits no work type. Usually bridged to exact-id by links.al anyway; ' +
      'the year is what covers the records MangaDex has not linked.',
  },
  {
    provider: 'MangaHere',
    year: false,
    type: false,
    note:
      'search cards carry only id/title/image/description/status. NO non-title field at all, so ' +
      "tier 2 is unreachable — MangaHere reaches 'exact-id' via MAL-Sync's MangaFox binding or it " +
      "stays 'unverified'. Status is not used; see the note on status below.",
  },
  {
    provider: 'MangaPill',
    year: false,
    type: false,
    note:
      'search cards carry only id/title/image/altTitles. No MAL-Sync coverage either (see ' +
      "PROVIDERS_WITHOUT_MALSYNC_COVERAGE), so MangaPill can NEVER exceed 'unverified' today. " +
      'Live 2026-08-14 its top hit for "Solo Leveling" is "Solo Leveling Novel" — the light novel — ' +
      'which the NOVEL_MARKER veto also catches independently.',
  },
  {
    provider: 'AsuraScans',
    year: false,
    type: true,
    note:
      '`type` is "manhwa"/"manga" verbatim from the JSON API; no year field. Also emits ' +
      '`chapterCount`/`latestChapter`, which are deliberately NOT read — see the header.',
  },
  {
    provider: 'FlameComics',
    year: true,
    type: true,
    note:
      'the only provider that supplies BOTH (releaseDate 2018 + type "Manhwa" for Solo Leveling), ' +
      'i.e. the only one that can reach tier 2 on the near-exact-title path rather than on equality.',
  },
  {
    provider: 'WeebCentral',
    year: true,
    type: false,
    note:
      '`releaseDate` is the series year as a string ("2018"); `genres` are story tags (Action, ' +
      'Shounen) and carry no origin word. Its "Solo Leveling (Volume)" record shares the year with ' +
      'the base record, so the bracketed-qualifier veto is what separates them.',
  },
  {
    provider: 'MangaKakalot',
    year: false,
    type: false,
    // Measured 2026-08-14 against the built dist, not read off the site: `search('One Piece', 1)`
    // returned 19 rows whose ONLY keys are id/title/headerForImage/image/description/matchedVia
    // (plus `approximateTitle` on inexact slug hits). No `releaseDate`, no `type` — on either the
    // slug-index path or the browse-listing fallback, since both build the row from a sitemap slug
    // and a detail-page <h1>.
    note:
      'search rows carry only id/title/image/description (+ matchedVia/approximateTitle), so NO ' +
      'non-title field exists and tier 2 is unreachable — the same shape as MangaHere. Unlike ' +
      "MangaPill this is NOT a dead end: MangaKakalot is absent from " +
      'PROVIDERS_WITHOUT_MALSYNC_COVERAGE because MAL-Sync binds the MangaNato site, so the id ' +
      "bridge carries it straight to 'exact-id' (verified: AniList manga 87216 -> " +
      "kimetsu-no-yaiba, via 'malsync'). When MAL-Sync has no record it falls back to title " +
      "matching and stays 'unverified'; there is no middle tier for it to land on.",
  },
];

/** Registry introspection for /manga diagnostics. Mirrors describeMangaMetadataLayer's role. */
export const describeMangaMatchClassifier = () => ({
  tiers: [
    { tier: 'exact-id', owner: 'id bridges (./manga-metadata.ts)', basis: 'an id equality asserted upstream' },
    {
      tier: 'metadata',
      owner: 'MetadataMatchClassifier',
      basis:
        'exact provider-PRIMARY-title equality + >=1 corroborating field, OR primary title >=' +
        `${NEAR_EXACT_TITLE} + 2 independent fields — and zero contradictions`,
    },
    { tier: 'unverified', owner: 'default', basis: 'title similarity alone — served, but labelled' },
  ],
  signalFields: ['year', 'type'],
  vetoFields: ['title', 'year', 'type'],
  signalCoverage: MANGA_CLASSIFIER_SIGNAL_COVERAGE.map(c => ({ ...c })),
  refusals: [
    'NO CHAPTER/VOLUME COUNT IS READ. AniList returns chapters:null AND volumes:null for every ' +
      'RELEASING series (re-verified live on manga id 30013), so a count check is absent exactly ' +
      'where wrong-match risk is highest; and where a count does exist it agrees with the colour ' +
      're-release it is supposed to reject. AnimeAggregator.EPISODE_COUNT_TOLERANCE has no port ' +
      'and none is faked. MangaDex lastChapter/lastVolume and AsuraScans chapterCount are ignored ' +
      'on purpose.',
    'STATUS IS NOT A SIGNAL. Ongoing/Completed is two-valued and drifts: a scanlation site that ' +
      'stopped updating reports Completed for a RELEASING series, and a colour re-release reports ' +
      'the same status as its base record. It discriminates nothing and would inflate the count.',
    'THE COMIC-VS-NOVEL AXIS IS A VETO ONLY, NEVER A SIGNAL. Every record on all six of these ' +
      'sites is a comic, so agreement carries ~no information.',
    'AUTHOR IS NOT USED. It is the strongest unused signal, and it is skipped deliberately: ' +
      'IMangaMeta carries no staff, only WeebCentral supplies authors in a search result, and name ' +
      'order/romanisation ("Oda Eiichiro" / "Eiichiro Oda" / "尾田栄一郎") would need its own ' +
      'evidence base before a comparison could be trusted.',
    "COUNTRY IS NOT INFERRED FROM MANGADEX'S originalLanguage. 'zh' maps to CN or TW with no way " +
      'to tell which — the same reason ./manga-metadata.ts refuses to backfill countryOfOrigin.',
  ],
  caveats: [
    'A veto can only ever cost confidence, never create it, so the vetoes are deliberately broad ' +
      'and the promotions deliberately narrow.',
    "Alt titles rank a candidate but never promote one: provider alt-title lists are franchise " +
      'lists (AsuraScans lists "Solo Leveling: Arise" — a different series — among the base Solo ' +
      "Leveling record's alt titles, captured live 2026-08-14).",
    'Two providers in the working set (MangaHere, MangaPill) publish no non-title field in a search ' +
      'result at all, so tier 2 is structurally unreachable for them. This is documented, not solved.',
  ],
});
