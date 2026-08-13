import { VideoExtractor, IVideo } from '../models';
import { unpackPacker } from '../utils/unpack-packer';

class Kwik extends VideoExtractor {
  protected override serverName = 'kwik';
  protected override sources: IVideo[] = [];

  private readonly host = 'https://animepahe.com';

  override extract = async (videoUrl: URL): Promise<IVideo[]> => {
    try {
      const { data } = await this.client.get(`${videoUrl.href}`, {
        headers: { Referer: this.host },
      });

      // The embed page is kwik's, not ours: expand its packed script as data. `eval`-ing it (what
      // this used to do) handed a third party arbitrary code execution in this process.
      const source = unpackPacker(data, videoUrl.href).match(/https.*?m3u8/);
      if (!source) throw new Error(`no m3u8 found in unpacked kwik embed: ${videoUrl.href}`);

      this.sources.push({
        url: source[0],
        isM3U8: source[0].includes('.m3u8'),
      });

      return this.sources;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };
}
export default Kwik;
