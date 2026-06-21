import { load } from 'cheerio';

import { VideoExtractor, IVideo, ISubtitle, Intro } from '../models';
import { USER_AGENT } from '../utils';
import { Console } from 'console';

/**
 * work in progress
 */
class Filemoon extends VideoExtractor {
  protected override serverName = 'Filemoon';
  protected override sources: IVideo[] = [];

  private readonly host = 'https://filemoon.sx';

  override extract = async (_videoUrl: URL): Promise<IVideo[]> => {
    // NON-FUNCTIONAL: the packed-eval unpacker was never finished — it built `newScript` then
    // discarded it and returned an empty source list. Fail loudly instead of silently yielding
    // no sources. Not reachable from any active provider (see TODO.md item 2 / extractors audit).
    throw new Error('Filemoon extractor not implemented');
  };
}

export default Filemoon;
