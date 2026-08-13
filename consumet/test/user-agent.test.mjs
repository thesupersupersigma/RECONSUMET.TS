// The shared scraping User-Agent.
//
// It had sat at Chrome/83.0.4103.116 — a mid-2020 build — for long enough to become a bot signal in
// its own right. This is a shape guard, not a version pin: it fails if someone pastes back an
// ancient UA or one in the pre-M107 full-build-number format, without demanding that the constant
// track Chrome's release schedule.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { USER_AGENT } = require('../dist/utils/utils.js');

describe('USER_AGENT is a plausible modern browser', () => {
  test('is a well-formed desktop Chrome UA', () => {
    assert.match(
      USER_AGENT,
      /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/,
      `not a current-shape Chrome UA: ${USER_AGENT}`
    );
  });

  test('uses the post-M107 reduced form, not a full build number', () => {
    // `Chrome/83.0.4103.116` — real Chrome has not sent build/patch digits since M107 (2022).
    assert.doesNotMatch(USER_AGENT, /Chrome\/\d+\.\d+\.\d{3,}\.\d+/, `pre-M107 full build number: ${USER_AGENT}`);
  });

  test('is not a stale major version', () => {
    // M120 shipped Dec 2023. Anything below that is old enough to stand out on its own.
    const major = Number(USER_AGENT.match(/Chrome\/(\d+)\./)[1]);
    assert.ok(major >= 120, `Chrome/${major} is stale — bump USER_AGENT in src/utils/utils.ts`);
  });
});
