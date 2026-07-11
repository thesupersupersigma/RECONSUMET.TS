import { VideoExtractor, IVideo, ISource } from '../models';
import { USER_AGENT, verifyMasterPlaylist } from '../utils';

/**
 * VibePlayer (vibeplayer.site) — the "HD-1" server on AniNeko.
 *
 * The embed (`https://vibeplayer.site/<id>`) is a jwplayer page whose HLS master
 * lives at a predictable path: `https://vibeplayer.site/public/stream/<id>/master.m3u8`.
 * The m3u8 is unencrypted and fetchable server-side (Referer-locked to the embed
 * origin). We fetch the embed to read the real source URL, falling back to the
 * constructed path.
 *
 * Subtitles are NOT here — on AniNeko they ride in the `data-video` query string
 * (`sub` / `caption_1` / `c1_file`); the provider attaches them.
 */
class VibePlayer extends VideoExtractor {
  protected override serverName = 'vibeplayer';
  protected override sources: IVideo[] = [];

  override extract = async (videoUrl: URL): Promise<ISource> => {
    try {
      const origin = videoUrl.origin;
      const id = videoUrl.pathname.split('/').filter(Boolean)[0];
      if (!id) throw new Error('no embed id in vibeplayer url');
      const headers = { Referer: `${origin}/`, 'User-Agent': USER_AGENT };

      let master = `${origin}/public/stream/${id}/master.m3u8`;
      try {
        const { data } = await this.client.get(videoUrl.href, { headers });
        const found = String(data).match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/)?.[0];
        if (found) master = found;
      } catch (_) {
        // fall back to the constructed path
      }

      // Hard existence check: confirm the master actually resolves upstream (2xx +
      // real HLS body) before we report it. A currently-airing episode can hand back
      // a well-formed URL that only 502/404s later at playback; throwing here lets the
      // aggregator fall through to the next candidate/provider instead.
      await verifyMasterPlaylist(this.client, master, headers);

      const result: ISource = {
        headers: { Referer: `${origin}/` },
        sources: [{ url: master, quality: 'auto', isM3U8: master.includes('.m3u8') }],
        subtitles: [],
      };

      // expand the HLS master into per-quality variants (best-effort)
      try {
        const { data: playlist } = await this.client.get(master, { headers });
        if (typeof playlist === 'string' && playlist.includes('#EXT-X-STREAM-INF')) {
          const base = master.slice(0, master.lastIndexOf('/') + 1);
          for (const part of playlist.split('#EXT-X-STREAM-INF:').slice(1)) {
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
        // variant expansion is optional
      }

      this.sources = result.sources;
      return result;
    } catch (err) {
      throw new Error(`VibePlayer extract failed: ${(err as Error).message}`);
    }
  };
}

export default VibePlayer;
