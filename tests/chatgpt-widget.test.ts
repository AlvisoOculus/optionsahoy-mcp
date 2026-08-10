// AlphaLatitude Inc. © 2026
//
// The ChatGPT Apps SDK widget, and - the point of this file - proof that it
// changes NOTHING for any other client.
//
// `content` and `structuredContent` are surfaced to the model, which composes
// the reply from them; that is why our scenario URL kept arriving mangled.
// A widget is rendered by the client, so its <a href> survives verbatim. But
// Claude, Cursor, npx/stdio, registries and plain SDK callers must keep seeing
// byte-identical responses, so most of these tests assert absence, not
// presence.

import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/mcp';
import { TOOLS, buildToolSpec } from '../functions/_lib/mcp-tools';
import { RESOURCES } from '../functions/_lib/mcp-resources';
import { SCENARIO_WIDGET_URI, SCENARIO_WIDGET_RESOURCE } from '../functions/_lib/mcp-widget';

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://optionsahoy.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'python-httpx/0.27.0', ...headers },
    body: JSON.stringify(body),
  });
}
const call = (name: string, args: unknown) => ({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
});
const AMT_ARGS = {
  shares: 10000, strike: 2, fmv: 200, ticker: 'AAPL', filingStatus: 'married_joint',
  ordinaryIncome: 400000, stateCode: 'CA', carryforwardCredit: 0, horizon: 4,
  grantDate: '2022-01-15', hasLeftCompany: false, terminationDate: null,
};

describe('widget wiring (what ChatGPT needs)', () => {
  it('every tool advertises the widget template in _meta', async () => {
    const res = await onRequest({ request: rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), env: {} });
    const tools = ((await res.json()) as { result: { tools: Array<{ name: string; _meta?: Record<string, string> }> } }).result.tools;
    expect(tools).toHaveLength(TOOLS.length);
    for (const t of tools) {
      expect(t._meta?.['openai/outputTemplate'], `${t.name} missing widget pointer`).toBe(SCENARIO_WIDGET_URI);
    }
  });

  it('the template URI is readable and self-contained', async () => {
    const res = await onRequest({
      request: rpc({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: SCENARIO_WIDGET_URI } }),
      env: {},
    });
    const body = (await res.json()) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } };
    const doc = body.result.contents[0];
    expect(doc.uri).toBe(SCENARIO_WIDGET_URI);
    expect(doc.mimeType).toBe('text/html+skybridge');
    // Reads the tool result the Apps SDK way, and renders a real anchor.
    expect(doc.text).toContain('window.openai');
    expect(doc.text).toContain('toolOutput');
    expect(doc.text).toContain('next_steps');
    expect(doc.text).toContain('<a class="cta"');
    // Self-contained: nothing for the host's CSP to block. Check the
    // LOADING attributes specifically - the widget's own JS legitimately
    // contains an https://optionsahoy.com pattern for validating the href.
    expect(doc.text).not.toMatch(/<script[^>]+\bsrc\s*=/i);
    expect(doc.text).not.toMatch(/<link[^>]+\bhref\s*=/i);
    expect(doc.text).not.toMatch(/<(img|iframe|source|video|audio)\b/i);
    expect(doc.text).not.toMatch(/@import|url\(/i);
    // The only absolute URL it may ever point a user at is ours, and it is
    // supplied at runtime from the tool result - never hardcoded here.
    expect(doc.text).not.toMatch(/href\s*=\s*["']https?:/i);
  });
});

describe('the widget script is idempotent (ChatGPT re-fires set_globals)', () => {
  // Shipped 2026-08-09 with an append-per-render bug: ChatGPT re-fires
  // openai:set_globals for theme/display/globals changes, and the card showed
  // the related-tools line a dozen times over. These assert on the emitted
  // script, since a DOM run needs a browser (covered by the manual harness).
  const html = SCENARIO_WIDGET_RESOURCE.contents;

  it('rebuilds the related-tools list instead of appending to it', () => {
    // The clear MUST precede the append, or repeated renders stack up.
    const clearAt = html.indexOf("more.textContent = ''");
    const appendAt = html.indexOf('more.appendChild');
    expect(clearAt).toBeGreaterThan(-1);
    expect(appendAt).toBeGreaterThan(clearAt);
    // Exactly one appendChild in the whole script - any other is a new leak.
    expect(html.match(/appendChild/g)).toHaveLength(1);
  });

  it('sets every other field rather than accumulating', () => {
    // textContent/setAttribute overwrite; insertAdjacentHTML/innerHTML +=
    // and createElement outside the rebuilt list would not.
    expect(html).not.toContain('insertAdjacentHTML');
    expect(html).not.toMatch(/innerHTML\s*\+=/);
    expect(html.match(/createElement/g)).toHaveLength(1);
  });

  it('skips the DOM entirely when the derived content is unchanged', () => {
    // Andrew observed "more than 12" fires for one answer, so treat the rate
    // as unbounded: a signature compare short-circuits before any write, and
    // the failure paths reset it so a later valid payload still renders.
    // (Browser-verified: 500 events -> 5 DOM mutations, 1 copy.)
    expect(html).toContain('var lastSig = null;');
    expect(html).toContain('if (sig === lastSig) return;');
    expect(html.match(/lastSig = null/g)?.length).toBeGreaterThanOrEqual(3);
    // The guard must sit before the first write, or it guards nothing.
    expect(html.indexOf('if (sig === lastSig) return;')).toBeLessThan(html.indexOf('cta.setAttribute'));
  });

  it('hides the card on every failure path instead of leaving a stale one', () => {
    // Three guards: no next_steps, non-optionsahoy href, and the catch.
    expect(html.match(/card\.hidden = true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('catch (e)');
  });
});

describe('non-interference (every other client)', () => {
  it('a tools/call response is unchanged: JSON block, prose block, structuredContent', async () => {
    const res = await onRequest({ request: rpc(call('amt_iso_optimize', AMT_ARGS)), env: {} });
    const r = ((await res.json()) as { result: { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> } }).result;
    // Exactly the two blocks we shipped before the widget - no third block,
    // no widget payload smuggled into the transcript.
    expect(r.content).toHaveLength(2);
    expect(() => JSON.parse(r.content[0].text)).not.toThrow();
    // The prose block still carries the full URL for clients with no widget.
    expect(r.content[1].text).toMatch(/https:\/\/optionsahoy\.com\/tools\/amt-iso\?src=mcp_amt_iso_sc&mcp=[A-Za-z0-9_-]+/);
    expect(r.content[1].text).toContain('You MUST share the link below');
    // The MODEL-VISIBLE surface is what must not change: per OpenAI's
    // reference, `content` and `structuredContent` are surfaced to the model
    // while result `_meta` is not. So assert those two carry no host-specific
    // keys - the protocol-level `_meta` pointer is allowed, and every client
    // ignores unknown `_meta` by spec.
    expect(JSON.stringify(r.content)).not.toContain('openai/');
    expect(JSON.stringify(r.content)).not.toContain('ui://');
    expect(JSON.stringify(r.structuredContent)).not.toContain('openai/');
    expect(JSON.stringify(r.structuredContent)).not.toContain('ui://');
  });

  it('resources/list keeps every document intact, plus the labelled template', async () => {
    // The widget IS listed: ChatGPT's detection wants the tool's
    // openai/outputTemplate and the corresponding ui:// resource, and hiding
    // it made the widget silently undiscoverable. What must not change is
    // the document set other clients actually read.
    const res = await onRequest({ request: rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' }), env: {} });
    const list = ((await res.json()) as { result: { resources: Array<{ uri: string; name: string; mimeType: string }> } }).result.resources;
    const docs = list.filter((r) => !r.uri.startsWith('ui://'));
    expect(docs).toHaveLength(RESOURCES.length);
    for (const r of docs) expect(r.mimeType).toBe('text/markdown');
    const widgets = list.filter((r) => r.uri.startsWith('ui://'));
    expect(widgets).toHaveLength(1);
    // Labelled so a human browsing another client's resource picker can see
    // at a glance that it is not a document.
    expect(widgets[0].name).toMatch(/widget/i);
    expect(widgets[0].mimeType).toBe('text/html+skybridge');
  });

  it('the published toolspec.json carries no host-specific metadata', () => {
    const spec = JSON.stringify(buildToolSpec());
    expect(spec).not.toContain('_meta');
    expect(spec).not.toContain('openai/');
    expect(spec).not.toContain('ui://');
  });

  it('an unknown resource URI still 400s the same way', async () => {
    const res = await onRequest({
      request: rpc({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://widget/not-ours.html' } }),
      env: {},
    });
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/Unknown resource/);
  });

  it('the stdio transport carries no widget metadata at all', async () => {
    // npx/MCPB installs serve Claude Desktop, Cursor and SDK clients - none
    // render Apps SDK widgets, so that transport projects no _meta and its
    // users keep the prose link. Read the source: importing the stdio entry
    // would start a server on stdio.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/stdio-server.ts', import.meta.url), 'utf8');
    const list = src.slice(src.indexOf('const TOOLS_LIST'), src.indexOf('const RESOURCES_LIST'));
    expect(list).not.toContain('_meta');
    expect(src).not.toContain('SCENARIO_WIDGET');
  });

  it('the widget is not mixed into the markdown document set', () => {
    // RESOURCES is the document corpus; the widget is appended at projection
    // time, so nothing that iterates documents picks up a UI template.
    expect(RESOURCES.some((r) => r.uri === SCENARIO_WIDGET_RESOURCE.uri)).toBe(false);
    expect(RESOURCES.every((r) => r.mimeType === 'text/markdown')).toBe(true);
  });
});
