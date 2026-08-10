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

// Executes the emitted script against a fake DOM. Every assertion below runs
// the real code rather than grepping the source, because the failure mode this
// file exists to prevent is behavioural - a render loop that accumulates, or a
// stale card left visible - and source-text assertions could not see any of
// it. A syntax error in the emitted JS also used to ship fully green, since
// nothing ever parsed it; `new Function` now catches that at test time. One
// did occur while this was being written: a stray backtick in a comment closed
// the enclosing TS template literal.
function runWidget() {
  const html = SCENARIO_WIDGET_RESOURCE.contents;
  const body = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const els: Record<string, Record<string, unknown>> = {};
  for (const id of ['oa', 'oa-title', 'oa-sub', 'oa-cta', 'oa-url']) {
    // Seed each element with the STATIC text the browser would have parsed
    // from the markup. Defaulting these to '' made assertions about
    // re-labelling vacuous - "the headline no longer says scenario" passed
    // against an empty string even when the code never touched the headline.
    const staticText = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? '';
    els[id] = {
      hidden: id === 'oa',
      textContent: staticText,
      attrs: {} as Record<string, string>,
      setAttribute(this: { attrs: Record<string, string> }, k: string, v: string) {
        this.attrs[k] = v;
      },
    };
  }
  const listeners: Array<() => void> = [];
  const win = {
    openai: undefined as unknown,
    addEventListener: (_e: string, fn: () => void) => listeners.push(fn),
  };
  let missing: string | null = null;
  const doc = { getElementById: (id: string) => (id === missing ? null : (els[id] ?? null)) };
  // Throws at parse time if the emitted JS is malformed.
  new Function('window', 'document', body)(win, doc);
  return {
    els,
    fire: () => listeners.forEach((fn) => fn()),
    setOutput: (next: unknown) => {
      win.openai = { toolOutput: next === null ? null : { next_steps: next } };
    },
    breakDom: (id: string | null) => {
      missing = id;
    },
  };
}

const LINK = 'https://optionsahoy.com/tools/rsu-sell-vs-hold?src=mcp_rsu_sc&mcp=AAA';

describe('the widget script runs correctly (ChatGPT re-fires set_globals)', () => {
  it('parses and renders a valid payload', () => {
    const w = runWidget();
    w.setOutput({ web_tool: LINK });
    w.fire();
    expect(w.els.oa.hidden).toBe(false);
    expect((w.els['oa-cta'].attrs as Record<string, string>).href).toBe(LINK);
    expect(w.els['oa-cta'].textContent).toBe('Open pre-filled calculator');
  });

  it('does no DOM work when the payload is unchanged', () => {
    // Shipped 2026-08-09 with an append-per-render bug: Andrew saw the
    // related-tools line "more than 12" times for one answer. ChatGPT re-fires
    // set_globals for theme and display changes, so treat the rate as
    // unbounded and require the repeat path to touch nothing at all.
    const w = runWidget();
    w.setOutput({ web_tool: LINK });
    let writes = 0;
    Object.defineProperty(w.els['oa-cta'], 'textContent', {
      set() {
        writes++;
      },
      get: () => '',
    });
    for (let i = 0; i < 500; i++) w.fire();
    expect(writes).toBe(1);
  });

  it('re-renders when the payload changes to another tool', () => {
    // All 8 tools share one template URI, so a second call can land on an
    // already-mounted widget.
    const w = runWidget();
    w.setOutput({ web_tool: LINK });
    w.fire();
    const other = 'https://optionsahoy.com/tools/amt-iso?src=mcp_amt_sc&mcp=BBB';
    w.setOutput({ web_tool: other });
    w.fire();
    expect((w.els['oa-cta'].attrs as Record<string, string>).href).toBe(other);
  });

  it('never leaves a stale card visible when a render throws mid-way', () => {
    // The regression this guards: committing the signature BEFORE the DOM
    // writes meant one throw pinned tool A's link on screen permanently while
    // the reply described tool B - a confidently wrong link, worse than none.
    const w = runWidget();
    w.setOutput({ web_tool: LINK });
    w.fire();
    const other = 'https://optionsahoy.com/tools/amt-iso?src=mcp_amt_sc&mcp=BBB';
    w.breakDom('oa-cta');
    w.setOutput({ web_tool: other });
    w.fire();
    expect(w.els.oa.hidden).toBe(true);
    w.breakDom(null);
    w.fire();
    expect(w.els.oa.hidden).toBe(false);
    expect((w.els['oa-cta'].attrs as Record<string, string>).href).toBe(other);
  });

  it('renders the scenario headline when the link does carry one', () => {
    // Pairs with the de-scope test below: without this, a mutation that drops
    // the headline swap entirely still passes, because the static markup
    // already says "scenario" and nothing would notice it never changed.
    const w = runWidget();
    w.setOutput({ web_tool: 'https://optionsahoy.com/tools/protective-put?src=mcp_protective_put' });
    w.fire();
    expect(String(w.els['oa-title'].textContent)).not.toContain('scenario');
    w.setOutput({ web_tool: LINK });
    w.fire();
    expect(String(w.els['oa-title'].textContent)).toContain('scenario');
  });

  it('hides the card when the payload goes away, and recovers after', () => {
    const w = runWidget();
    w.setOutput({ web_tool: LINK });
    w.fire();
    w.setOutput(null);
    w.fire();
    expect(w.els.oa.hidden).toBe(true);
    w.setOutput({ web_tool: LINK });
    w.fire();
    expect(w.els.oa.hidden).toBe(false);
  });

  it('de-scopes the headline when the link carries no scenario', () => {
    // protective_put_price has no scenario resolver, so 100% of its calls take
    // this path; the card must not offer to open "this scenario" above a link
    // that opens an empty form.
    const w = runWidget();
    w.setOutput({ web_tool: 'https://optionsahoy.com/tools/protective-put?src=mcp_protective_put' });
    w.fire();
    expect(w.els.oa.hidden).toBe(false);
    expect(String(w.els['oa-title'].textContent)).not.toContain('scenario');
    expect(w.els['oa-cta'].textContent).toBe('Open calculator');
  });

  it('rejects every off-origin and non-https href', () => {
    // The origin regex is the security control, so exercise its behaviour
    // rather than grepping for its source text: "tidying" \\. to . silently
    // turns the dot into a wildcard and nothing else would notice.
    const w = runWidget();
    for (const bad of [
      'https://optionsahoy.com.evil.com/tools/x',
      'https://optionsahoy.com@evil.com/tools/x',
      'https://evil.com/?u=https://optionsahoy.com/',
      'https://optionsahoyxcom/tools/x',
      'http://optionsahoy.com/tools/x',
      'https://optionsahoy.com',
      '',
    ]) {
      w.setOutput({ web_tool: bad });
      w.fire();
      expect(w.els.oa.hidden, bad).toBe(true);
    }
    // A scheme prefixed onto our own URL is not hidden, it is DEFANGED: the
    // href is sliced from the first `https://`, so the scheme the browser
    // sees is always https and the leading `javascript:`/`data:` payload is
    // discarded rather than navigated to. Assert the invariant that matters -
    // whatever renders points at our origin - rather than the hide.
    for (const prefixed of [
      'javascript:alert(1)//https://optionsahoy.com/tools/x',
      'data:text/html,<b>x</b>https://optionsahoy.com/tools/x',
    ]) {
      w.setOutput({ web_tool: prefixed });
      w.fire();
      const href = (w.els['oa-cta'].attrs as Record<string, string>).href;
      expect(href, prefixed).toMatch(/^https:\/\/optionsahoy\.com\//);
      expect(href, prefixed).not.toContain('javascript:');
      expect(href, prefixed).not.toContain('data:');
    }
    // ...while our own origin renders, in either host case and with or
    // without www., since neither changes the origin.
    for (const ok of [
      LINK,
      LINK.replace('optionsahoy.com', 'www.optionsahoy.com'),
      LINK.replace('optionsahoy.com', 'OptionsAhoy.com'),
    ]) {
      w.setOutput({ web_tool: ok });
      w.fire();
      expect(w.els.oa.hidden, ok).toBe(false);
    }
  });

  it('makes no network calls of any kind', () => {
    const html = SCENARIO_WIDGET_RESOURCE.contents;
    expect(html).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|\bimport\s*\(|sendBeacon/);
    expect(html).not.toMatch(/<(object|embed|svg|form)\b|srcdoc/i);
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
