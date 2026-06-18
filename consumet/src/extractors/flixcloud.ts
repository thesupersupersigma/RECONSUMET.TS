import { VideoExtractor, IVideo, ISource, ISubtitle } from '../models';
import { USER_AGENT } from '../utils';

/**
 * FlixCloud (flixcloud.cc) — the "HD-2" server behind Re:ANIME (reanime.to).
 *
 * The embed (`https://flixcloud.cc/e/<id>?v=2`) is a SvelteKit page that ships a
 * big inline `data` payload. Two very different things live in it:
 *
 * 1. **Soft subtitles — plain, unencrypted.** A `subtitles:[{url,language,format}]`
 *    array of `.ass` files on `*.overcdn.site` (fansub-grade, styled; e.g.
 *    "English (Full Subtitles)"). We extract these directly — no crypto needed.
 *    This is the only reason the extractor is useful *today*.
 *
 * 2. **The m3u8 video URL — heavily protected (NOT yet cracked).** The manifest
 *    URL is recovered client-side via a megacloud-tier chain:
 *      - deobfuscate the field-name map with `obfuscation_seed`,
 *      - round-trip a token from their API (returns `frag1_b64` + fragments),
 *      - run 3 buffers through a tiny WASM cipher (`w_payload`; the `_r` export is
 *        `v = A^B^C ^0x48; rotl2(v); ^0xF2; ^((i*60+seed)&0xFF)`),
 *      - PBKDF2 the WASM output, then AES-256-CBC decrypt the manifest.
 *    Porting that to TS is a deliberate, rotating anti-scrape wall. It is tracked
 *    in repo-root `SOURCES.md` ("reanime.to — flixcloud stream crack") as future
 *    work; until then `sources` is returned empty.
 *
 * So: browser-free, gives high-quality `.ass` English soft subs for free, video
 * pending the crack.
 */
class FlixCloud extends VideoExtractor {
  protected override serverName = 'flixcloud';
  protected override sources: IVideo[] = [];

  override extract = async (videoUrl: URL): Promise<ISource> => {
    try {
      const headers = { Referer: 'https://reanime.to/', 'User-Agent': USER_AGENT };
      const { data } = await this.client.get(videoUrl.href, { headers });
      const html = String(data);

      const subtitles: ISubtitle[] = [];
      // subtitles ride in the inline data payload as unquoted-key objects:
      //   {url:"https://…overcdn.site/subtitles/…/eng_4.ass",language:"English …",format:"ass",default:true}
      const re = /url:"([^"]+\.(?:ass|vtt|srt))"\s*,\s*language:"([^"]*)"/g;
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const url = m[1];
        if (seen.has(url)) continue;
        seen.add(url);
        subtitles.push({ url, lang: m[2] || 'English' });
      }

      // TODO(reanime stream crack): decrypt `obfuscated_crypto_data` → m3u8.
      // See SOURCES.md. Until then we surface subtitles only.
      const result: ISource = {
        headers: { Referer: 'https://reanime.to/' },
        sources: [],
        subtitles,
      };

      this.sources = result.sources;
      return result;
    } catch (err) {
      throw new Error(`FlixCloud extract failed: ${(err as Error).message}`);
    }
  };
}

export default FlixCloud;
