#!/usr/bin/env node
// A stand-in for curl-impersonate, so the argv path of impersonatedFetch() can be tested OFFLINE.
//
// WHY THIS EXISTS. server.mjs spawns `CURL_BIN` (= process.env.CURL_IMPERSONATE_BIN) with one
// `-H "${name}: ${value}"` argv pair per outbound header. That is the path where user-supplied
// header values have no wire framing protecting them, and it is the path every previous pass left
// UNMEASURED, because no curl-impersonate binary is installed locally. `CURL_IMPERSONATE_BIN` is
// just a path, so it can point here instead: this script answers the protocol the real binary
// speaks and hands its own argv back as the response body, which /proxy then streams to the test.
//
// THE PROTOCOL impersonatedFetch() expects (spawn stdio is ['ignore','pipe','pipe','pipe']):
//   fd 3  — the `-D` header dump. The parent resolves its promise as soon as this contains a blank
//           line, so the status line + headers + CRLFCRLF must be written here FIRST.
//   fd 1  — the response body, streamed straight through to the /proxy client.
// Nothing is written to fd 2 (the parent treats stderr as the failure explanation).
//
// The body is `JSON.stringify(process.argv.slice(2))` — the EXACT argv, so a test can assert on
// what would have gone to the real curl. `content-type: text/plain` keeps /proxy out of its
// playlist-rewriting branch, and no content-length is declared so the body streams as-is.
//
// FAKE_CURL_LOG, when set, names a file this script APPENDS one JSON argv line to per invocation.
// That is what lets a test assert a rejected request never reached the upstream stand-in AT ALL,
// rather than merely inferring it from a status code.
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.FAKE_CURL_LOG) {
  try {
    fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify(argv) + '\n');
  } catch {
    /* logging is best-effort; never fail the request over it */
  }
}
fs.writeSync(3, 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n');
fs.writeSync(1, Buffer.from(JSON.stringify(argv), 'utf8'));
process.exit(0);
