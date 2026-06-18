import { VideoExtractor, IVideo } from '../models';
import { USER_AGENT } from '../utils';

class VidMoly extends VideoExtractor {
  protected override serverName = 'vidmoly';
  protected override sources: IVideo[] = [];

  override extract = async (videoUrl: URL): Promise<IVideo[]> => {
    try {
      const origin = `${videoUrl.protocol}//${videoUrl.host}/`;
      const headers = { 'User-Agent': USER_AGENT, Referer: origin };
      const { data } = await this.client.get(videoUrl.href, { headers });

      // jwplayer's `file:` may use single OR double quotes
      const links = data.match(/file:\s*["']([^"']+)["']/);
      if (!links?.[1]) throw new Error('vidmoly: no source file found on embed page');

      const m3u8Content = await this.client.get(links[1], { headers });

      this.sources.push({
        quality: 'auto',
        url: links[1],
        isM3U8: links[1].includes('.m3u8'),
      });

      if (m3u8Content.data.includes('EXTM3U')) {
        const videoList = m3u8Content.data.split('#EXT-X-STREAM-INF:');
        for (const video of videoList ?? []) {
          if (!video.includes('m3u8')) continue;

          const url = video.split('\n')[1];
          const quality = video.split('RESOLUTION=')[1].split(',')[0].split('x')[1];

          this.sources.push({
            url: url,
            quality: `${quality}`,
            isM3U8: url.includes('.m3u8'),
          });
        }
      }

      return this.sources;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };
}
export default VidMoly;
