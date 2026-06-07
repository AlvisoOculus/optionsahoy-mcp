// AlphaLatitude Inc. © 2026
//
// Tests for the public /api/v1/usage adoption page: the pure ASCII-rendering
// helpers (the part with real logic) plus a render smoke test over a mocked
// D1 binding.

import { describe, it, expect } from 'vitest';
import {
  onRequest,
  zeroFillDaily,
  bucketCumulative,
  renderColumns,
  sparkline,
} from '../functions/mcp/usage';
import type { D1Database, D1PreparedStatement, Env, PagesContext } from '../functions/_lib/stats';

describe('zeroFillDaily', () => {
  it('fills gaps with 0 and spans first day through today', () => {
    const { days, counts } = zeroFillDaily(
      [
        { day: '2026-06-01', n: 3 },
        { day: '2026-06-04', n: 5 },
      ],
      '2026-06-05',
    );
    expect(days).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']);
    expect(counts).toEqual([3, 0, 0, 5, 0]);
  });

  it('returns empty for no rows', () => {
    expect(zeroFillDaily([], '2026-06-05')).toEqual({ days: [], counts: [] });
  });
});

describe('bucketCumulative', () => {
  it('produces a monotonic running total ending at the grand total', () => {
    const { cols, total } = bucketCumulative([1, 2, 3, 4], 56);
    expect(cols).toEqual([1, 3, 6, 10]);
    expect(total).toBe(10);
    for (let i = 1; i < cols.length; i++) expect(cols[i]).toBeGreaterThanOrEqual(cols[i - 1]);
  });

  it('compresses to at most maxCols columns and widens the bucket', () => {
    const counts = Array.from({ length: 200 }, () => 1);
    const { cols, bucketDays, total } = bucketCumulative(counts, 56);
    expect(cols.length).toBeLessThanOrEqual(56);
    expect(bucketDays).toBe(Math.ceil(200 / 56)); // 4
    expect(total).toBe(200);
    expect(cols[cols.length - 1]).toBe(200);
  });
});

describe('renderColumns', () => {
  it('renders `height` rows, bottom-anchored', () => {
    const rows = renderColumns([0, 10], 4);
    expect(rows).toHaveLength(4);
    // bottom row: max column full, zero column blank
    const bottom = rows[rows.length - 1];
    expect(bottom[1]).toBe('█');
    expect(bottom[0]).toBe(' ');
    // a full-height (max) column fills every row
    expect(rows.every((r) => r[1] === '█')).toBe(true);
  });
});

describe('sparkline', () => {
  it('shows a block for any nonzero day and a space for zero', () => {
    const s = sparkline([0, 1, 8]);
    expect(s).toHaveLength(3);
    expect(s[0]).toBe(' ');
    expect(s[1]).not.toBe(' '); // nonzero is always visible
    expect(s[2]).toBe('█'); // the max
  });
});

// ---- render smoke test ---------------------------------------------------

function mockDb(daily: { day: string; n: number }[], lastTs: number | null): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      const isDaily = /GROUP BY day/.test(sql);
      const rows = isDaily ? daily : [{ t: lastTs }];
      const obj: D1PreparedStatement = {
        bind() {
          return obj;
        },
        async run() {
          return undefined;
        },
        async all<T = unknown>() {
          return { results: rows as T[] };
        },
      };
      return obj;
    },
  };
}

function ctx(env: Env, method = 'GET'): PagesContext {
  return {
    request: new Request('http://localhost/mcp/usage', { method }),
    env,
    waitUntil: () => undefined,
  };
}

describe('GET /api/v1/usage', () => {
  it('renders an HTML page in marine with block glyphs and an sr-only total', async () => {
    const env: Env = { MCP_STATS: mockDb([{ day: '2026-06-01', n: 4 }, { day: '2026-06-02', n: 6 }], 1_750_000_000_000) };
    const res = await onRequest(ctx(env));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('#2E7A7A'); // OA marine
    expect(html).toContain('total tool calls');
    expect(html).toContain('10 total'); // 4 + 6
    expect(html).toMatch(/[█▁▂▃▄▅▆▇]/); // a block glyph rendered
    expect(html).toContain('/api/v1/stats'); // live-data link
    expect(html).toContain('sr-only'); // accessible numbers present
  });

  it('shows a warming-up page when the binding is missing', async () => {
    const res = await onRequest(ctx({}));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Warming up');
  });

  it('405s on non-GET', async () => {
    const res = await onRequest(ctx({ MCP_STATS: mockDb([], null) }, 'POST'));
    expect(res.status).toBe(405);
  });
});
