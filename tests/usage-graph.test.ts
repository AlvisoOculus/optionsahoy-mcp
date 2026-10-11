// AlphaLatitude Inc. © 2026
//
// Tests for the public /api/v1/usage adoption page: the pure ASCII-rendering
// helpers (the part with real logic) plus a render smoke test over a mocked
// D1 binding.

import { describe, it, expect } from 'vitest';
import {
  onRequest,
  zeroFillDaily,
  cumulativePerDay,
  resampleToWidth,
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

describe('cumulativePerDay', () => {
  it('returns the running total', () => {
    expect(cumulativePerDay([1, 2, 3, 4])).toEqual([1, 3, 6, 10]);
    expect(cumulativePerDay([])).toEqual([]);
  });
});

describe('resampleToWidth (constant-width)', () => {
  it('expands fewer values across a fixed width, pinning endpoints', () => {
    const out = resampleToWidth([1, 3, 6, 10], 8);
    expect(out).toHaveLength(8);
    expect(out[0]).toBe(1); // first column = first value
    expect(out[out.length - 1]).toBe(10); // last column = grand total
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]); // monotonic
  });

  it('compresses more values into a fixed width, still ending at the total', () => {
    const cum = Array.from({ length: 200 }, (_, i) => i + 1); // 1..200
    const out = resampleToWidth(cum, 56);
    expect(out).toHaveLength(56);
    expect(out[0]).toBe(1);
    expect(out[out.length - 1]).toBe(200);
  });

  it('always returns exactly `width` columns regardless of input length', () => {
    expect(resampleToWidth([42], 56)).toHaveLength(56);
    expect(resampleToWidth([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(resampleToWidth([5], 56).every((v) => v === 5)).toBe(true);
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
  const now = Date.now();
  const total = daily.reduce((a, d) => a + d.n, 0);
  return {
    prepare(sql: string): D1PreparedStatement {
      let rows: unknown[] = [];
      if (/FROM stats_snapshot WHERE id = 1/.test(sql)) {
        rows = [{ total, last_id: 1, last_ts: lastTs, computed_at: now }];
      } else if (/FROM mcp_daily ORDER BY day/.test(sql)) rows = daily;
      const stmt: D1PreparedStatement = {
        bind() {
          return stmt;
        },
        async run() {
          return undefined;
        },
        async all<T>() {
          return { results: rows as T[] };
        },
      };
      return stmt;
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
