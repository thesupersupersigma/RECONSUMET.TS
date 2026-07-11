import { VideoExtractor, IVideo, ISource } from '../models';
import { USER_AGENT, verifyMasterPlaylist } from '../utils';

/**
 * MegaPlay (megaplay.buzz) extractor.
 *
 * Given a MegaPlay embed URL (e.g. `https://megaplay.buzz/stream/s-2/<id>/<sub|dub>`)
 * it reads the embed page's `data-id`, then calls the unencrypted
 * `/stream/getSources?id=<data-id>` JSON endpoint which returns an HLS master
 * playlist plus subtitle tracks. No decryption required.
 *
 * Note: the returned m3u8/vtt URLs are hotlink-protected and require the
 * `Referer: https://megaplay.buzz/` header (returned in `headers`).
 */
class MegaPlay extends VideoExtractor {
  protected override serverName = 'megaplay';
  protected override sources: IVideo[] = [];

  private readonly defaultHost = 'https://megaplay.buzz';

  override extract = async (videoUrl: URL): Promise<ISource> => {
    const origin = videoUrl.origin || this.defaultHost;
    const headers = { Referer: `${origin}/`, 'User-Agent': USER_AGENT };
    try {
      // 1) embed page -> data-id
      const { data: embed } = await this.client.get(videoUrl.href, { headers });
      const dataId = String(embed).match(/data-id=["'](\d+)["']/)?.[1];
      if (!dataId) throw new Error('could not find data-id on embed page');

      // 2) unencrypted sources JSON
      const { data } = await this.client.get(`${origin}/stream/getSources?id=${dataId}`, {
        headers: { ...headers, Referer: videoUrl.href, 'X-Requested-With': 'XMLHttpRequest' },
      });

      const file: string | undefined = data?.sources?.file;
      if (!file) throw new Error('no source file in getSources response');

      // Hard existence check: confirm the master `file` actually resolves upstream
      // (2xx + real HLS body) before reporting it. A currently-airing episode can
      // return a well-formed URL that only 502/404s later at playback; throwing here
      // lets the aggregator fall through to the next candidate/provider instead.
      await verifyMasterPlaylist(this.client, file, headers);

      const result: ISource = {
        headers: { Referer: `${origin}/` },
        sources: [{ url: file, quality: 'default', isM3U8: file.includes('.m3u8') }],
        subtitles: [],
      };

      // expand HLS master playlist into per-quality variants (best-effort)
      try {
        const { data: playlist } = await this.client.get(file, { headers });
        if (typeof playlist === 'string' && playlist.includes('#EXT-X-STREAM-INF')) {
          const base = file.slice(0, file.lastIndexOf('/') + 1);
          for (const part of playlist.split('#EXT-X-STREAM-INF:').slice(1)) {
            const line = part.split('\n').find(l => l.trim().endsWith('.m3u8'))?.trim();
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

      // subtitles / captions
      result.subtitles = (data?.tracks ?? [])
        .filter((t: any) => t?.file && (t.kind === 'captions' || t.kind === 'subtitles'))
        .map((t: any) => ({ url: t.file, lang: t.label ?? 'Unknown' }));

      // intro / outro skip markers
      if (data?.intro?.end > 0) result.intro = { start: data.intro.start, end: data.intro.end };
      if (data?.outro?.end > 0) result.outro = { start: data.outro.start, end: data.outro.end };

      this.sources = result.sources;
      return result;
    } catch (err) {
      throw new Error(`MegaPlay extract failed: ${(err as Error).message}`);
    }
  };
}

export default MegaPlay;
