import { createDecipheriv } from 'crypto';

import { VideoExtractor, IVideo, ISource } from '../models';
import { USER_AGENT, verifyMasterPlaylist } from '../utils';

/**
 * Nova (nova.upn.one) extractor.
 *
 * The embed (`https://nova.upn.one/#<id>`) is an SPA that reads `<id>` from the
 * URL hash and calls `GET /api/v1/video?id=<id>`, which returns an
 * **AES-128-CBC-encrypted hex** blob. The key/IV are derived in-page from
 * `location.protocol` + constants (independent of the id), so they are
 * effectively static — reproduced here so extraction stays browser-free:
 *   key = `kiemtienmua911ca`, iv = `1234567890oiuytr`.
 *
 * Decrypting yields JSON whose `cf` field is an HLS master playlist (served as
 * `cf-master.*.txt`), fetchable server-side with no TLS gate. Nova multiplexes
 * delivery across several CDNs, so it is a robust video source.
 *
 * NOTE: Nova exposes **no soft subtitle tracks** — its "SUB" encodes are
 * hardsubbed (English burned into the video), so `subtitles` is always empty.
 * If the site rotates its bundle, the key/IV below may need updating.
 */
class Nova extends VideoExtractor {
  protected override serverName = 'nova';
  protected override sources: IVideo[] = [];

  private readonly host = 'https://nova.upn.one';
  private readonly key = Buffer.from('kiemtienmua911ca');
  private readonly iv = Buffer.from('1234567890oiuytr');

  override extract = async (videoUrl: URL): Promise<ISource> => {
    try {
      const id = videoUrl.hash.replace(/^#/, '').split('&')[0] || videoUrl.pathname.split('/').filter(Boolean).pop();
      if (!id) throw new Error('no video id in embed url');
      const headers = { Referer: `${this.host}/`, 'User-Agent': USER_AGENT };

      const { data: hex } = await this.client.get(`${this.host}/api/v1/video?id=${id}`, { headers });
      const decipher = createDecipheriv('aes-128-cbc', this.key, this.iv);
      const json = Buffer.concat([
        decipher.update(Buffer.from(String(hex), 'hex')),
        decipher.final(),
      ]).toString('utf8');
      const data = JSON.parse(json);

      const master: string | undefined = data?.cf || data?.source;
      if (!master) throw new Error('no master playlist in decrypted payload');

      // Hard existence check: confirm the master actually resolves upstream (2xx +
      // real HLS body) before reporting it. Nova's only master fetch below is
      // best-effort, so without this a currently-airing episode's 502/404 master
      // would still be returned as a "successful" source. Throwing here lets the
      // aggregator fall through to the next candidate/provider instead.
      await verifyMasterPlaylist(this.client, master, headers);

      const result: ISource = {
        headers: { Referer: `${this.host}/` },
        sources: [{ url: master, quality: 'auto', isM3U8: true }],
        subtitles: [],
      };

      // expand the HLS master into per-quality variants (best-effort)
      try {
        const { data: playlist } = await this.client.get(master, { headers });
        if (typeof playlist === 'string' && playlist.includes('#EXT-X-STREAM-INF')) {
          const base = master.slice(0, master.lastIndexOf('/') + 1);
          for (const part of playlist.split('#EXT-X-STREAM-INF:').slice(1)) {
            // line 0 is the tag's attribute list; the URI is the next non-blank line
            const line = part
              .split('\n')
              .slice(1)
              .map(l => l.trim())
              .find(l => l && !l.startsWith('#'));
            if (!line) continue;
            const quality = part.match(/RESOLUTION=\d+x(\d+)/)?.[1];
            result.sources.push({
              url: line.startsWith('http') ? line : base + line,
              quality: quality ? `${quality}p` : 'auto',
              isM3U8: true,
            });
          }
        }
      } catch (_) {
        // variant expansion is optional; master playlist is already returned
      }

      this.sources = result.sources;
      return result;
    } catch (err) {
      throw new Error(`Nova extract failed: ${(err as Error).message}`);
    }
  };
}

export default Nova;
