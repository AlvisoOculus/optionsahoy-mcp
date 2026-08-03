// AlphaLatitude Inc. © 2026
//
// Attribution guard for the MCP resources. Resources are what an agent reads
// BEFORE choosing a tool, so a click through from one is high-intent - but
// every link in them was untagged until 2026-08-03, making that whole path
// invisible in the funnel. The `uri` fields are resources/read lookup keys
// and must never be tagged, or the read breaks.

import { describe, it, expect } from 'vitest';
import { RESOURCES } from '../functions/_lib/mcp-resources';

const LINK_RE = /https:\/\/optionsahoy\.com\/(?:learn|tools)\/[a-z0-9-]+/g;

function bodyOf(r: (typeof RESOURCES)[number]): string {
  return typeof r.contents === 'string' ? r.contents : '';
}

describe('resource body links carry attribution; URIs stay bare', () => {
  it('finds resource body text to check (guards against a vacuous pass)', () => {
    const withText = RESOURCES.filter((r) => bodyOf(r).length > 200);
    expect(withText.length).toBeGreaterThanOrEqual(6);
  });

  it('every optionsahoy learn/tools link in resource text carries a src bucket', () => {
    let checked = 0;
    for (const r of RESOURCES) {
      const text = bodyOf(r);
      for (const link of text.match(LINK_RE) ?? []) {
        const idx = text.indexOf(link);
        const following = text.slice(idx + link.length, idx + link.length + 24);
        // Skip prose mentions that are not followed by a URL boundary we own.
        if (following.startsWith('?')) {
          expect(following, `${r.uri}: wrong bucket on ${link}`).toMatch(/^\?src=mcp_res_/);
          checked++;
        } else {
          expect(following, `${r.uri}: untagged link ${link}`).toMatch(/^[\s.,)]|^$/);
        }
      }
    }
    expect(checked, 'no tagged links found - the tagging regressed').toBeGreaterThanOrEqual(7);
  });

  it('resource URIs are never tagged (they are resources/read lookup keys)', () => {
    for (const r of RESOURCES) expect(r.uri).not.toContain('src=');
  });
});
