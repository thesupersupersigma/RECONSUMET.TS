import * as crypto from 'crypto';

import { VideoExtractor, IVideo, ISource, ISubtitle } from '../models';
import { USER_AGENT } from '../utils';

/**
 * FlixCloud (flixcloud.cc) — the "HD-2" server behind Re:ANIME (reanime.to).
 *
 * The embed (`https://flixcloud.cc/e/<id>?v=2`) is a SvelteKit page whose inline
 * `data` payload hides the stream behind a multi-stage, self-rotating scheme.
 * This extractor reproduces it fully, server-side and browser-free:
 *
 *  1. **Field-name deobfuscation** — every sensitive field is stored under a name
 *     derived from `obfuscation_seed` via chained SHA-256 (see {@link deriveFields}).
 *  2. **Token round-trip** — `GET /api/m3u8/<tokenRef>` returns a JSON map keyed by
 *     `sha256(tokenRef+"vid")[:10]` (the AES-encrypted manifest URL) and
 *     `sha256(tokenRef+"key")[:10]` (the third key fragment).
 *  3. **WASM key cipher** — the embed ships a tiny WASM module (`w_payload`, exports
 *     `_s`/`_r`/`_c`). We instantiate the site's own module and feed it the three
 *     32-byte fragments (`kf_*` field, the `keyFrag2` field, and the token fragment)
 *     plus the seed → 32-byte intermediate `E`. (Using the real WASM keeps us correct
 *     even if they tweak the cipher constants.)
 *  4. **Key derivation** — `PBKDF2(E, salt=seed, 1000, SHA-256, 32B)`, XOR each byte
 *     with `seed[i % len]`, then SHA-256 → the AES-256 key.
 *  5. **AES-256-CBC** decrypt the manifest ciphertext (iv = `ivf_*` field) → the
 *     final signed HLS URL on `fetch5.flixcloud.cc`.
 *
 * The resulting `master.m3u8` is JWT-signed (IP-locked, ~6h TTL). NOTE: the stream
 * CDN (`fetch5.flixcloud.cc`) sits behind a Cloudflare bot-management / TLS
 * (JA3) gate, so the playlist/segments must be fetched by a TLS-impersonating
 * client (the API's stream proxy / ViperTLS), not plain axios. The embed host and
 * the `.ass` subtitle CDN (`*.overcdn.site`) are NOT gated.
 *
 * Subtitles are plain, unencrypted `.ass` files (fansub/Aegisub-grade, styled,
 * e.g. "English (Full Subtitles)"), pulled straight from the payload.
 */
class FlixCloud extends VideoExtractor {
  protected override serverName = 'flixcloud';
  protected override sources: IVideo[] = [];

  private static sha256Hex(input: string | Buffer): string {
    return crypto.createHash('sha256').update(input as any).digest('hex');
  }

  /** value of a payload field whose key is `name` (quoted or bare identifier) */
  private static field(html: string, name: string): string | undefined {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.match(new RegExp(`"?${esc}"?\\s*:\\s*"([^"]*)"`))?.[1];
  }

  /** derive the obfuscated field names from `obfuscation_seed` (chained SHA-256) */
  private static deriveFields(seed: string) {
    let e = seed;
    for (let o = 0; o < 3; o++) e = FlixCloud.sha256Hex(e + o.toString());
    let s = e;
    for (let o = 0; o < 3; o++) s = FlixCloud.sha256Hex(s + o.toString());
    return {
      keyField: `kf_${e.substring(8, 16)}`,
      ivField: `ivf_${e.substring(16, 24)}`,
      tokenField: `${e.substring(48, 64)}_${e.substring(56, 64)}`,
      keyFrag2Field: `${s.substring(0, 16)}_${s.substring(16, 24)}`,
    };
  }

  /** run the embed's own WASM `_r` cipher over the three fragments → 32-byte E */
  private static async runWasmCipher(
    wPayloadB64: string,
    a: Buffer,
    b: Buffer,
    c: Buffer,
    seedInt: number
  ): Promise<Buffer> {
    const wasm = await WebAssembly.instantiate(Buffer.from(wPayloadB64, 'base64'), {});
    const exp: any = wasm.instance.exports;
    const mem: WebAssembly.Memory = exp.memory;
    if (mem.buffer.byteLength === 0) mem.grow(1);

    const k = a.length;
    const aPtr = 1000;
    const bPtr = aPtr + k;
    const cPtr = bPtr + k;
    const outPtr = cPtr + k;
    const view = new Uint8Array(mem.buffer);
    view.set(a, aPtr);
    view.set(b, bPtr);
    view.set(c, cPtr);
    exp._s(seedInt);
    exp._r(aPtr, bPtr, cPtr, outPtr, k);
    return Buffer.from(view.subarray(outPtr, outPtr + k));
  }

  override extract = async (videoUrl: URL): Promise<ISource> => {
    try {
      const referer = 'https://reanime.to/';
      const headers = { Referer: referer, 'User-Agent': USER_AGENT };
      const { data } = await this.client.get(videoUrl.href, { headers });
      const html = String(data);

      // --- subtitles (plain, no crypto) ---
      const subtitles: ISubtitle[] = [];
      const subRe = /url:"([^"]+\.(?:ass|vtt|srt))"\s*,\s*language:"([^"]*)"/g;
      const seenSub = new Set<string>();
      let sm: RegExpExecArray | null;
      while ((sm = subRe.exec(html)) !== null) {
        if (seenSub.has(sm[1])) continue;
        seenSub.add(sm[1]);
        subtitles.push({ url: sm[1], lang: sm[2] || 'English' });
      }

      // --- decrypt the m3u8 ---
      const seed = html.match(/obfuscation_seed:"([0-9a-f]+)"/)?.[1];
      const wPayload = html.match(/w_payload:"([A-Za-z0-9+/=]+)"/)?.[1];
      let m3u8: string | undefined;

      if (seed && wPayload) {
        const f = FlixCloud.deriveFields(seed);
        const frag1 = FlixCloud.field(html, f.keyField);
        const ivB64 = FlixCloud.field(html, f.ivField);
        const keyFrag2 = FlixCloud.field(html, f.keyFrag2Field);
        const tokenRef = FlixCloud.field(html, f.tokenField);

        if (frag1 && ivB64 && keyFrag2 && tokenRef) {
          // token round-trip on the (un-gated) embed host
          const { data: token } = await this.client.get(`${videoUrl.origin}/api/m3u8/${tokenRef}`, {
            headers: { ...headers, Referer: `${videoUrl.origin}/` },
          });
          const vKey = FlixCloud.sha256Hex(tokenRef + 'vid').substring(0, 10);
          const tKey = FlixCloud.sha256Hex(tokenRef + 'key').substring(0, 10);
          const cipherB64: string | undefined = token?.[vKey];
          const frag3B64: string | undefined = token?.[tKey];

          if (cipherB64 && frag3B64) {
            const E = await FlixCloud.runWasmCipher(
              wPayload,
              Buffer.from(frag1, 'base64'),
              Buffer.from(keyFrag2, 'base64'),
              Buffer.from(frag3B64, 'base64'),
              parseInt(seed.substring(0, 8), 16)
            );
            const derived = crypto.pbkdf2Sync(E, Buffer.from(seed, 'utf8'), 1000, 32, 'sha256');
            for (let i = 0; i < 32; i++) derived[i] ^= seed.charCodeAt(i % seed.length);
            const aesKey = crypto.createHash('sha256').update(derived).digest();
            const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, Buffer.from(ivB64, 'base64'));
            const url = Buffer.concat([
              decipher.update(Buffer.from(cipherB64, 'base64')),
              decipher.final(),
            ]).toString('utf8');
            if (/^https?:\/\/\S+\.m3u8/.test(url)) m3u8 = url.trim();
          }
        }
      }

      const result: ISource = {
        // playlist + segments are on a CF/JA3-gated CDN — fetch via the
        // TLS-impersonating stream proxy, with this Referer.
        headers: { Referer: 'https://flixcloud.cc/' },
        sources: m3u8 ? [{ url: m3u8, quality: 'auto', isM3U8: true }] : [],
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
