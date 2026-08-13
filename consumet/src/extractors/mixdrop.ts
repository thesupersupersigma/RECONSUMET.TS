import { VideoExtractor, IVideo } from '../models';
import { unpackPacker } from '../utils/unpack-packer';

class MixDrop extends VideoExtractor {
  protected override serverName = 'MixDrop';
  protected override sources: IVideo[] = [];

  override extract = async (videoUrl: URL): Promise<IVideo[]> => {
    try {
      const { data } = await this.client.get(videoUrl.href);

      // MixDrop's page is third-party: expand its packed script as data, never execute it.
      const formated = unpackPacker(data, videoUrl.href);

      const matches = formated.match(/poster="([^"]+)"|wurl="([^"]+)"/g);
      if (!matches) throw new Error(`no poster/wurl found in unpacked MixDrop embed: ${videoUrl.href}`);

      const [poster, source] = matches
        .map((x: string) => x.split(`="`)[1].replace(/"/g, ''))
        .map((x: string) => (x.startsWith('http') ? x : `https:${x}`));

      this.sources.push({
        url: source,
        isM3U8: source.includes('.m3u8'),
        poster: poster,
      });

      return this.sources;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };
}
export default MixDrop;
