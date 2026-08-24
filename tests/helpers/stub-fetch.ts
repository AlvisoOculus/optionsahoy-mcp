// AlphaLatitude Inc. © 2026
//
// The one way this suite fakes the network. Both published-artifact readers
// (lib/data/live-vols, lib/data/live-chain) are exercised by stubbing `fetch`
// and asserting what they do with the answer, so the stub and its JSON
// response builder live here rather than in each reader's test file.

import { vi } from 'vitest';

/** Replace global fetch for the current test. `vi.unstubAllGlobals()` in an
 *  afterEach puts it back. Returns the spy, so a test can assert the URL and
 *  the call count as well as the outcome. */
export function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl as never);
  vi.stubGlobal('fetch', spy);
  return spy;
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
