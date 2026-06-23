// AlphaLatitude Inc. © 2026
//
// Tests for the Poe server-bot endpoint (functions/poe.ts). The query path is
// driven with an injected extractor so no network call to Poe is made; the
// deterministic calculation still runs through the real TOOLS handler.

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/poe';
import {
  handleQuery,
  headline,
  freeToolLink,
  parseJsonObject,
  readSseText,
  extractorPrompt,
} from '../functions/poe';

const KEY = 'i2xRD3eNjktfohwlGLWBh1UGwB69Ky5w';

function poeRequest(body: unknown, auth?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers['authorization'] = auth;
  return new Request('http://localhost/poe', { method: 'POST', headers, body: JSON.stringify(body) });
}

// Valid amt_iso args (ticker resolves growth/vol, like the MCP dedup test).
const AMT_ARGS = {
  shares: 10000, strike: 2, fmv: 40, ticker: 'AAPL',
  filingStatus: 'married_joint', ordinaryIncome: 300000, stateCode: 'CA',
  carryforwardCredit: 0, horizon: 4, cashReturnRate: 0.05,
  grantDate: '2022-01-01', hasLeftCompany: false, terminationDate: null,
};

describe('poe auth', () => {
  it('rejects a query with a wrong bearer when the key is configured', async () => {
    const res = await onRequest({
      request: poeRequest({ type: 'query', query: [] }, 'Bearer wrong'),
      env: { POE_ACCESS_KEY: KEY },
    } as any);
    expect(res.status).toBe(401);
  });

  it('allows a settings request with the correct bearer', async () => {
    const res = await onRequest({
      request: poeRequest({ type: 'settings' }, `Bearer ${KEY}`),
      env: { POE_ACCESS_KEY: KEY },
    } as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.server_bot_dependencies).toBeTruthy();
    expect(Object.keys(body.server_bot_dependencies).length).toBe(1);
    expect(typeof body.introduction_message).toBe('string');
    expect(body.content_type).toBe('text/markdown');
  });

  it('skips auth when no key is configured (pre-secret deploy)', async () => {
    const res = await onRequest({
      request: poeRequest({ type: 'settings' }),
      env: {},
    } as any);
    expect(res.status).toBe(200);
  });
});

describe('poe settings dependency uses the configured extractor bot', () => {
  it('declares the override bot name', async () => {
    const res = await onRequest({
      request: poeRequest({ type: 'settings' }),
      env: { POE_EXTRACTOR_BOT: 'Claude-Haiku' },
    } as any);
    const body = (await res.json()) as any;
    expect(body.server_bot_dependencies['Claude-Haiku']).toBe(1);
  });
});

describe('poe query path', () => {
  it('runs the real optimizer and returns its NFV + a poe-tagged free-tool link', async () => {
    const extractor = async () => ({ tool: 'amt_iso_optimize', args: AMT_ARGS });
    const res = await handleQuery({ type: 'query', query: [{ role: 'user', content: 'best ISO schedule?' }] }, {}, extractor);
    const text = await res.text();
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('event: text');
    expect(text).toContain('event: done');
    expect(text).toContain('Optimized after-tax net final value');
    expect(text).toContain('?src=poe_amt_iso');
    expect(text).toContain('deterministic optimum, not an estimate');
  });

  it('relays a clarify question verbatim', async () => {
    const extractor = async () => ({ clarify: 'What is your filing status and state?' });
    const res = await handleQuery({ type: 'query', query: [{ role: 'user', content: 'help' }] }, {}, extractor);
    const text = await res.text();
    expect(text).toContain('What is your filing status and state?');
  });

  it('handles an off-topic rejection gracefully', async () => {
    const extractor = async () => ({ reject: 'That is not an equity-compensation question.' });
    const res = await handleQuery({ type: 'query', query: [{ role: 'user', content: 'weather?' }] }, {}, extractor);
    const text = await res.text();
    expect(text).toContain('not an equity-compensation question');
  });

  it('degrades gracefully when the handler rejects bad inputs', async () => {
    const extractor = async () => ({ tool: 'amt_iso_optimize', args: { shares: -5 } });
    const res = await handleQuery({ type: 'query', query: [{ role: 'user', content: 'bad' }] }, {}, extractor);
    const text = await res.text();
    expect(text).toContain('optionsahoy.com/tools/amt-iso?src=poe_amt_iso');
  });

  it('returns the intro when there is no user message', async () => {
    const res = await handleQuery({ type: 'query', query: [] }, {}, async () => null);
    const text = await res.text();
    expect(text).toContain('equity-compensation');
  });

  it('falls back when extraction yields nothing', async () => {
    const res = await handleQuery({ type: 'query', query: [{ role: 'user', content: 'x' }] }, {}, async () => null);
    const text = await res.text();
    expect(text).toContain('optionsahoy.com/tools');
  });
});

describe('poe helpers', () => {
  it('freeToolLink retags mcp -> poe and keeps the slug', () => {
    expect(freeToolLink('qsbs_check')).toBe('optionsahoy.com/tools/qsbs?src=poe_qsbs');
  });

  it('parseJsonObject extracts fenced JSON', () => {
    expect(parseJsonObject('```json\n{"tool":"x","args":{}}\n```')).toEqual({ tool: 'x', args: {} });
    expect(parseJsonObject('noise {"a":1} tail')).toEqual({ a: 1 });
    expect(parseJsonObject('no json here')).toBeNull();
  });

  it('readSseText concatenates text events and surfaces errors', () => {
    const sse = 'event: text\ndata: {"text":"hel"}\n\nevent: text\ndata: {"text":"lo"}\n\nevent: done\ndata: {}\n\n';
    expect(readSseText(sse).text).toBe('hello');
    const err = 'event: error\ndata: {"text":"insufficient_fund"}\n\n';
    expect(readSseText(err).error).toBe('insufficient_fund');
  });

  it('extractorPrompt lists all seven tools', () => {
    const p = extractorPrompt('q');
    for (const name of ['amt_iso_optimize', 'nso_calculate', 'rsu_sell_vs_hold', 'concentration_analyze', 'protective_put_price', 'qsbs_check', 'equity_funding_plan']) {
      expect(p).toContain(name);
    }
  });

  it('headline falls back for an unknown shape', () => {
    expect(headline('amt_iso_optimize', {})).toContain('result is ready');
  });
});
