import { Cheerio, load } from 'cheerio';

import {
  AnimeParser,
  ISearch,
  IAnimeInfo,
  IAnimeResult,
  ISource,
  IEpisodeServer,
  SubOrSub,
} from '../../models';

class AnimeUnity extends AnimeParser {
  override readonly name = 'AnimeUnity';
  // NOTE (2026-08): animeunity.to now 301-redirects to animeunity.so — use the
  // canonical domain directly instead of depending on the redirect surviving.
  // The site is fronted by Cloudflare as a passive CDN only (no challenge): every
  // endpoint returns 200 to plain axios with no cookies/headers from residential IPs.
  // Blanket 403s are Cloudflare IP-reputation blocks on datacenter IPs (e.g. cloud VMs),
  // not something fixable client-side.
  protected override baseUrl = 'https://www.animeunity.so';
  protected override logo = 'https://www.animeunity.so/favicon-32x32.png';
  protected override classPath = 'ANIME.AnimeUnity';

  /**
   * @param query Search query
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    try {
      const res = await this.client.get(`${this.baseUrl}/archivio?title=${encodeURIComponent(query)}`);
      const $ = load(res.data);

      if (!$) return { results: [] };

      // The <archivio> web-component carries the search results as a JSON string in
      // its `records` attribute. Guard both the missing-attribute and bad-JSON cases
      // so a markup change (or a Cloudflare IP-block stub that lacks the element)
      // yields an actionable error instead of JSON.parse choking on "undefined".
      const records = $('archivio').attr('records');
      if (!records)
        throw new Error(
          'AnimeUnity: search page has no <archivio records="..."> element. ' +
            'Site markup may have changed, or the request was blocked (Cloudflare datacenter-IP block serves a stub page).'
        );

      let items: any[];
      try {
        items = JSON.parse(records);
      } catch {
        throw new Error(
          'AnimeUnity: failed to parse the <archivio> "records" JSON — the site markup likely changed.'
        );
      }

      const searchResult: {
        hasNextPage: boolean;
        results: IAnimeResult[];
      } = {
        hasNextPage: false,
        results: [],
      };

      for (const i in items) {
        searchResult.results.push({
          id: `${items[i].id}-${items[i].slug}`,
          title: items[i].title ?? items[i].title_eng,
          url: `${this.baseUrl}/anime/${items[i].id}-${items[i].slug}`,
          image: items[i].imageurl,
          cover: items[i].imageurl_cover,
          rating: parseFloat(items[i].score),
          releaseDate: items[i].date,
          subOrDub: `${items[i].dub ? SubOrSub.DUB : SubOrSub.SUB}`,
        });
      }

      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id Anime id
   * @param page Page number
   */
  override fetchAnimeInfo = async (id: string, page: number = 1): Promise<IAnimeInfo> => {
    const url = `${this.baseUrl}/anime/${id}`;
    const episodesPerPage = 120;
    const lastPageEpisode = page * episodesPerPage;
    const firstPageEpisode = lastPageEpisode - 119;
    const url2 = `${this.baseUrl}/info_api/${id}/1?start_range=${firstPageEpisode}&end_range=${lastPageEpisode}`;

    try {
      const res = await this.client.get(url);
      const $ = load(res.data);

      const totalEpisodes = parseInt($('video-player')?.attr('episodes_count') ?? '0');
      const totalPages = Math.round(totalEpisodes / 120) + 1;

      if (page < 1 || page > totalPages)
        throw new Error(
          `Argument 'page' for ${id} must be between 1 and ${totalPages}! (You passed ${page})`
        );

      const animeInfo: IAnimeInfo = {
        currentPage: page,
        hasNextPage: totalPages > page,
        totalPages: totalPages,
        id: id,
        title: $('h1.title')?.text().trim(),
        url: url,
        alID: $('.banner')?.attr('style')?.split('/')?.pop()?.split('-')[0],
        genres:
          $('.info-wrapper.pt-3.pb-3 small')
            ?.map((_, element): string => {
              return $(element).text().replace(',', '').trim();
            })
            .toArray() ?? undefined,
        totalEpisodes: totalEpisodes,
        image: $('img.cover')?.attr('src'),
        // image: $('meta[property="og:image"]')?.attr('content'),
        cover: $('.banner')?.attr('src') ?? $('.banner')?.attr('style')?.replace('background: url(', ''),
        description: $('.description').text().trim(),
        episodes: [],
      };

      // fetch episodes method 1 (only first page can be fetchedd)
      // const items = JSON.parse("" + $('video-player').attr('episodes') + "")

      // fetch episodes method 2 (all pages can be fetched)
      const res2 = await this.client.get(url2);
      const items = res2.data.episodes;

      for (const i in items) {
        animeInfo.episodes?.push({
          id: `${id}/${items[i].id}`,
          number: parseInt(items[i].number),
          url: `${url}/${items[i].id}`,
        });
      }

      return animeInfo;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param episodeId Episode id (format: `<animeId-slug>/<episodeId>`)
   * @param server Ignored — AnimeUnity exposes a single embed (vixcloud) per episode.
   * @param subOrDub Optional. On AnimeUnity, sub and dub are SEPARATE anime entries
   *   (e.g. `1469-naruto` = sub, `1468-naruto-ita` = dub), each with its own episode
   *   ids — you cannot switch languages for a given episode id. So this is treated as
   *   an assertion: when explicitly provided, it is validated against the entry's own
   *   `dub` flag and a clear error is thrown on mismatch, rather than silently serving
   *   the wrong language. Selecting the dubbed version must happen at search/info time.
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server?: string,
    subOrDub?: 'sub' | 'dub'
  ): Promise<ISource> => {
    try {
      const res = await this.client.get(`${this.baseUrl}/anime/${episodeId}`);
      const $ = load(res.data);

      // Validate the requested language against this entry's actual dub flag. On
      // AnimeUnity dub is a distinct title, so a mismatch can never be satisfied
      // from this episode id — surface it instead of returning the wrong language.
      if (subOrDub) {
        const animeAttr = $('video-player').attr('anime');
        let entryIsDub: boolean | undefined;
        if (animeAttr) {
          try {
            entryIsDub = !!JSON.parse(animeAttr)?.dub;
          } catch {
            // couldn't read the flag — degrade gracefully, don't block the fetch
          }
        }
        if (entryIsDub !== undefined && (subOrDub === 'dub') !== entryIsDub)
          throw new Error(
            `AnimeUnity: episode "${episodeId}" is a ${entryIsDub ? 'dub' : 'sub'}-only title, ` +
              `but "${subOrDub}" was requested. On AnimeUnity the ${subOrDub} version is a separate ` +
              `entry — select it from search results (dubs use the "-ita" slug / dub=1) and use its episode ids.`
          );
      }

      const episodeSources: ISource = {
        sources: [],
      };

      const streamUrl = $('video-player').attr('embed_url');

      if (streamUrl) {
        const res = await this.client.get(streamUrl);
        const $ = load(res.data);

        // The embed page defines `window.video = { url, token, expires, ... }`. If the
        // embed host is region-blocked or the layout changes, .match() returns null;
        // fail with an explicit "layout changed" message instead of an opaque
        // "Cannot read properties of null" from a non-null assertion.
        const embedScript = $('script:contains("window.video")').text();
        const domain = embedScript.match(/url: '(.*)'/)?.[1];
        const token = embedScript.match(/token': '(.*)'/)?.[1];
        const expires = embedScript.match(/expires': '(.*)'/)?.[1];

        if (!domain || !token || !expires)
          throw new Error(
            'AnimeUnity: could not extract stream url/token/expires from the embed page (window.video). ' +
              'The embed layout may have changed, or the embed host is region-blocked and served a different page.'
          );

        const defaultUrl = `${domain}?token=${token}&referer=&expires=${expires}&h=1`;
        const m3u8Content = await this.client.get(defaultUrl);

        // Confirm the master really is a live HLS manifest before reporting success —
        // same guarantee as verifyMasterPlaylist(), applied to the body we already
        // fetched. Otherwise a 200-with-stub-body (dead/not-yet-encoded stream) would
        // be reported as a playable source.
        const masterBody = typeof m3u8Content.data === 'string' ? m3u8Content.data : String(m3u8Content.data);
        if (!masterBody.includes('#EXTM3U'))
          throw new Error(
            `AnimeUnity: master playlist for "${episodeId}" is not a valid HLS manifest ` +
              `(dead or not-yet-encoded stream?): ${defaultUrl}`
          );

        const videoList = masterBody.split('#EXT-X-STREAM-INF:');
        for (const video of videoList ?? []) {
          if (video.includes('BANDWIDTH')) {
            const url = video.split('\n')[1];
            const quality = video.split('RESOLUTION=')[1].split('\n')[0].split('x')[1];

            episodeSources.sources.push({
              url: url,
              quality: `${quality}p`,
              isM3U8: true,
            });
          }
        }

        episodeSources.sources.push({
          url: defaultUrl,
          quality: `default`,
          isM3U8: true,
        });

        // Download URL is a bonus — absence shouldn't fail the whole fetch.
        const downloadUrl = $('script:contains("window.downloadUrl ")')
          .text()
          .match(/downloadUrl = '(.*)'/)?.[1];
        if (downloadUrl) episodeSources.download = downloadUrl.toString();
      }

      return episodeSources;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   *
   * @param episodeId Episode id
   */
  override fetchEpisodeServers = (episodeId: string): Promise<IEpisodeServer[]> => {
    throw new Error('Method not implemented.');
  };
}

export default AnimeUnity;

/**
 * old episode sources fetching method, keep it here.
 */
// const domain = $('script:contains("window.video")').text()?.match(/url: '(.*)'/)![1]
// const token = $('script:contains("window.video")').text()?.match(/token': '(.*)'/)![1]
// const token360p = $('script:contains("window.video")').text()?.match(/token360p': '(.*)'/)![1]
// const token480p = $('script:contains("window.video")').text()?.match(/token480p': '(.*)'/)![1]
// const token720p = $('script:contains("window.video")').text()?.match(/token720p': '(.*)'/)![1]
// const token1080p = $('script:contains("window.video")').text()?.match(/token1080p': '(.*)'/)![1]
// const expires = $('script:contains("window.video")').text()?.match(/expires': '(.*)'/)![1]

// episodeSources.sources.push({
//     url: `${domain}?token=${token}&token360p=${token360p}&token480p=${token480p}&token720p=${token720p}&token1080p=${token1080p}&referer=&expires=${expires}`,
//     isM3U8: true
// })
