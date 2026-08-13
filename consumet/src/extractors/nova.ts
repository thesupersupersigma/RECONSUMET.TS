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
 */
class Nova extends VideoExtractor {
  protected override serverName = 'nova';
  protected override sources: IVideo[] = [];

  private readonly host = 'https://nova.upn.one';
  /**
   * AES-128-CBC key/IV, hardcoded ON PURPOSE — but they are the kind of value that rotates, so read
   * this before trusting them. The player derives them in-page from `location.protocol` + constants,
   * i.e. per bundle rather than per video. Sourcing them live (the fix that made Mkissa's rotating
   * signing key a non-event) does not work here: Mkissa's key material sits in the page as readable
   * data, whereas Nova ships a content-hashed, string-table-mangled bundle
   * (`/assets/index-<hash>.js`) that contains neither literal — checked against the live bundle. The
   * only ways to re-derive would be to execute the site's JavaScript (the eval() pattern this
   * codebase has just finished removing) or to regex an 880KB minified bundle, which is itself a
   * pinned assumption that breaks on the next deploy.
   *
   * So the tradeoff taken is: keep them static, and make a rotation UNMISTAKABLE rather than a
   * mystery empty result — see {@link Nova.ROTATED} below. If that error appears, pull the current
   * bundle and re-derive.
   */
  private readonly key = Buffer.from('kiemtienmua911ca');
  private readonly iv = Buffer.from('1234567890oiuytr');

  /** the one message that says "the static key stopped working", with everything needed to fix it */
  private static readonly ROTATED =
    'Nova: /api/v1/video did not decrypt with the static AES key — the site has almost certainly ' +
    'rotated it (key "kiemtienmua911ca", iv "1234567890oiuytr"). Re-derive from the current ' +
    'https://nova.upn.one/assets/index-<hash>.js bundle and update src/extractors/nova.ts';

  override extract = async (videoUrl: URL): Promise<ISource> => {
    try {
      const id = videoUrl.hash.replace(/^#/, '').split('&')[0] || videoUrl.pathname.split('/').filter(Boolean).pop();
      if (!id) throw new Error('no video id in embed url');
      const headers = { Referer: `${this.host}/`, 'User-Agent': USER_AGENT };

      const { data: hex } = await this.client.get(`${this.host}/api/v1/video?id=${id}`, { headers });

      // Check the response IS ciphertext before decrypting it. Buffer.from(x, 'hex') decodes
      // non-hex input to an empty buffer without complaining, so a plain-JSON error body (the API
      // answers `{"message":"Video not found or deleted"}`), an HTML interstitial or an empty body
      // would otherwise surface as an unrelated OpenSSL padding error — indistinguishable from a
      // rotated key, which is how this class of break stays invisible.
      // axios parses a JSON body into an object before we see it, and `String({…})` is
      // "[object Object]" — which would throw away the very message that explains the failure.
      const blob = (typeof hex === 'string' ? hex : JSON.stringify(hex)).trim();
      if (blob.length === 0 || blob.length % 32 !== 0 || !/^[0-9a-fA-F]+$/.test(blob)) {
        throw new Error(
          `/api/v1/video?id=${id} did not return an AES hex blob — got ${blob.length} chars ` +
            `(${JSON.stringify(blob.slice(0, 120))}). Nova's API format or gating may have changed`
        );
      }

      let json: string;
      try {
        const decipher = createDecipheriv('aes-128-cbc', this.key, this.iv);
        json = Buffer.concat([decipher.update(Buffer.from(blob, 'hex')), decipher.final()]).toString('utf8');
      } catch (err) {
        // wrong key/iv → PKCS7 padding check fails here
        throw new Error(`${Nova.ROTATED} — ${(err as Error).message}`);
      }

      let data: any;
      try {
        data = JSON.parse(json);
      } catch {
        // padding validates by chance (~1/256 with a wrong key) but the plaintext is garbage
        throw new Error(`${Nova.ROTATED} — decrypted payload is not JSON (${JSON.stringify(json.slice(0, 80))})`);
      }

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
