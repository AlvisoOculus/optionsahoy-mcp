// AlphaLatitude Inc. © 2026
//
// GET /mcp/usage — public, no-auth adoption page.
//
// Renders a text-based (ASCII) graph of MCP tool-call adoption from the
// MCP_STATS D1 table: a cumulative curve over all history (resampled to a
// constant width, expanding or compressing to fill it) plus a per-day sparkline for
// recent momentum. Styled in OptionsAhoy marine. The real numbers are also
// emitted in an sr-only block for screen readers and crawlers.
//
// Routed under /mcp/* (which the worker-proxy forwards to
// optionsahoy-mcp.pages.dev) rather than /api/v1/* on purpose: it is a human
// HTML page, not part of the JSON REST API documented in openapi.json. The
// admin page at /admin/* is NOT proxied and stays private. `ts` in mcp_calls
// is epoch milliseconds, so day bucketing divides by 1000 for SQLite's
// unixepoch.
//
// No call is logged for a page view here — this is a human page, not an MCP
// call, and logging it would pollute the very stats it displays.

import { type PagesFunction } from '../_lib/api';
import { type D1Database } from '../_lib/stats';

interface DayRow {
  day: string;
  n: number;
}

// Rollup-backed: the all-history curve reads mcp_daily (a few hundred
// rows, one per day) instead of GROUP BY over every call ever logged -
// the unbounded scan was part of the 2026-09-01 read outage. ensureFresh
// keeps today's bucket live, and because the curve lives in the rollup it
// SURVIVES retention deletes of old mcp_calls rows.
import { ensureFresh, readDaily } from '../_lib/statsRollup';

const GRAPH_COLS = 56; // constant chart width; days are resampled to fill it
const HEIGHT = 8; // cumulative chart rows
const SPARK_DAYS = 60; // per-day window
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// ---- pure helpers (exported for tests) -----------------------------------

// Turn sparse {day,n} rows into a dense, zero-filled count-per-day array from
// the first day with a call through `todayIso` inclusive. Missing days are 0
// so the curve is continuous instead of skipping gaps.
export function zeroFillDaily(rows: DayRow[], todayIso: string): { days: string[]; counts: number[] } {
  if (rows.length === 0) return { days: [], counts: [] };
  const byDay = new Map(rows.map((r) => [r.day, r.n]));
  const start = Date.parse(rows[0].day + 'T00:00:00Z');
  const end = Date.parse(todayIso + 'T00:00:00Z');
  const days: string[] = [];
  const counts: number[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    days.push(iso);
    counts.push(byDay.get(iso) ?? 0);
  }
  return { days, counts };
}

// Running cumulative total, one entry per day.
export function cumulativePerDay(counts: number[]): number[] {
  const out: number[] = [];
  let running = 0;
  for (const c of counts) {
    running += c;
    out.push(running);
  }
  return out;
}

// Resample a series to exactly `width` columns by nearest-index mapping with
// the endpoints pinned (first column = values[0], last column = values[last]).
// Fewer days than columns repeats each day across several columns (expand);
// more days than columns samples down (compress). Cumulative input stays
// monotonic either way, and the final column always equals the grand total.
export function resampleToWidth(values: number[], width: number): number[] {
  if (values.length === 0 || width <= 0) return [];
  if (values.length === 1) return Array.from({ length: width }, () => values[0]);
  if (values.length === width) return values.slice();
  const last = values.length - 1;
  const out: number[] = [];
  for (let i = 0; i < width; i++) {
    const idx = width === 1 ? last : Math.round((i * last) / (width - 1));
    out.push(values[idx]);
  }
  return out;
}

// Vertical block-bar chart: `height` rows of eighth-blocks, bottom-anchored.
export function renderColumns(values: number[], height = HEIGHT): string[] {
  if (values.length === 0) return Array.from({ length: height }, () => '');
  const max = Math.max(1, ...values);
  const eighths = values.map((v) => Math.round((v / max) * height * 8));
  const rows: string[] = [];
  for (let level = height - 1; level >= 0; level--) {
    let line = '';
    for (const e of eighths) line += BLOCKS[Math.max(0, Math.min(8, e - level * 8))];
    rows.push(line);
  }
  return rows;
}

// One-line sparkline. Any nonzero day shows at least the smallest block so a
// day with traffic is never invisible.
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  return values
    .map((v) => {
      if (v <= 0) return BLOCKS[0];
      return BLOCKS[Math.max(1, Math.min(8, Math.round((v / max) * 8)))];
    })
    .join('');
}

function relativeAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return 'n/a';
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 0) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- HTML ----------------------------------------------------------------

function emptyPage(): string {
  return page(
    `<h1>OptionsAhoy MCP &mdash; adoption</h1>
<p class="meta">Warming up. No tool calls recorded yet.</p>`,
  );
}

function page(inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OptionsAhoy MCP &mdash; adoption</title>
<meta name="robots" content="index, follow">
<style>
  :root { --marine:#2E7A7A; --marine-dark:#1F5C5C; --tint:#F0F8F8; --muted:#6a8a8a; }
  body { font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--tint); color:var(--marine-dark); margin:0; padding:34px 18px; }
  .wrap { max-width:760px; margin:0 auto; }
  h1 { font:600 18px/1.3 -apple-system,system-ui,sans-serif; color:var(--marine-dark); margin:0 0 3px; }
  h2 { font:600 11px/1 -apple-system,system-ui,sans-serif; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:26px 0 8px; }
  .meta { font:12px/1.5 -apple-system,system-ui,sans-serif; color:var(--muted); margin:0; }
  pre { color:var(--marine); margin:0; overflow-x:auto; font-size:13px; line-height:1.0; }
  pre .axis { color:var(--muted); }
  a { color:var(--marine); }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
</style>
</head>
<body><div class="wrap">
${inner}
<p class="meta" style="margin-top:26px">Live machine-readable data: <a href="/api/v1/stats">/api/v1/stats</a></p>
</div></body></html>`;
}

// ---- handler -------------------------------------------------------------

export const onRequest: PagesFunction = async (ctx) => {
  const { request, env } = ctx;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  const db = env?.MCP_STATS as D1Database | undefined;
  if (!db) {
    return new Response(emptyPage(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const snap = await ensureFresh(db, Date.now());
  const dailyRows = await readDaily(db);
  const lastT = snap.last_ts;
  const rows = dailyRows;
  if (rows.length === 0) {
    return new Response(emptyPage(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }

  const { days, counts } = zeroFillDaily(rows, today);
  const cum = cumulativePerDay(counts);
  const total = cum[cum.length - 1] ?? 0;
  const cols = resampleToWidth(cum, GRAPH_COLS);
  const cumRows = renderColumns(cols);
  const sparkWindow = counts.slice(-SPARK_DAYS);
  const spark = sparkline(resampleToWidth(sparkWindow, GRAPH_COLS));
  const numDays = days.length;
  const firstDay = days[0];
  const lastTs = lastT;

  // Cumulative chart with a small y-axis label column + baseline.
  const totalStr = total.toLocaleString('en-US');
  const labelW = totalStr.length;
  const pad = (s: string) => s.padStart(labelW);
  const chart = cumRows
    .map((r, i) => `${i === 0 ? pad(totalStr) : ' '.repeat(labelW)} ┤${r}`)
    .join('\n');
  const baseline = `${pad('0')} └${'─'.repeat(cols.length)}`;
  const gap = Math.max(1, cols.length - firstDay.length - today.length);
  const xaxis = `<span class="axis">${' '.repeat(labelW + 2)}${esc(firstDay)}${' '.repeat(gap)}${esc(today)}</span>`;

  const perCol = Math.ceil(numDays / GRAPH_COLS);
  const colCaption =
    numDays >= GRAPH_COLS
      ? `${numDays} days, 1 column ≈ ${perCol} day${perCol === 1 ? '' : 's'}`
      : `${numDays} day${numDays === 1 ? '' : 's'}`;
  const sparkFrom = days[Math.max(0, days.length - SPARK_DAYS)];

  // sr-only: real numbers for screen readers and crawlers (last 30 days).
  const recent = days
    .slice(-30)
    .map((d, i) => `${d}:${counts[counts.length - Math.min(30, days.length) + i]}`)
    .join(', ');

  const inner = `<h1>OptionsAhoy MCP &mdash; adoption</h1>
<p class="meta">${totalStr} total tool calls &middot; ${esc(firstDay)} &rarr; ${esc(today)} &middot; last call ${relativeAge(lastTs)} &middot; live, refreshes every 5 min</p>

<h2>Cumulative calls (${colCaption})</h2>
<pre>${esc(chart)}
${esc(baseline)}
${xaxis}</pre>

<h2>Calls per day (since ${esc(sparkFrom)})</h2>
<pre>${esc(spark)}</pre>

<div class="sr-only">Cumulative total ${total} MCP tool calls from ${esc(firstDay)} through ${esc(today)}. Daily counts for the last 30 days: ${esc(recent)}.</div>`;

  return new Response(page(inner), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
};
