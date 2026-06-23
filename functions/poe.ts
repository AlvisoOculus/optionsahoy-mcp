// AlphaLatitude Inc. © 2026
//
// POST /poe — OptionsAhoy as a Poe server bot.
//
// Implements the Poe protocol (version 1.2) directly in a Cloudflare Pages
// Function, no fastapi-poe. Flow per user message:
//   1. A cheap Poe dependency bot maps the natural-language question to one of
//      the seven OptionsAhoy calculators and extracts its JSON arguments. The
//      dependency call is billed to the chatting user (we pass through user_id
//      and metadata), so it costs us nothing.
//   2. The deterministic OptionsAhoy calculator runs locally (the same TOOLS
//      handlers as /mcp and /api/v1). The MATH IS NEVER done by the language
//      model: it only extracts inputs.
//   3. We format the optimizer's own numbers and stream them back as Poe SSE,
//      with a free-tool link carrying ?src=poe_<tool> for attribution.
//
// Incoming requests are authenticated against POE_ACCESS_KEY (the 32-character
// key Poe issues when the bot is created); that same key authenticates our
// dependency-bot calls.

import { TOOLS } from './_lib/mcp-tools';
import { PER_TOOL_FREE_TOOL_BARE } from './_lib/sessions';
import { logCall } from './_lib/stats';
import type { PagesContext, PagesFunction } from './_lib/api';

const PROTOCOL_VERSION = '1.2';
const POE_BOT_API = 'https://api.poe.com/bot/';
const POE_COST_API = 'https://api.poe.com/bot/cost/';
const DEFAULT_EXTRACTOR = 'Assistant';
// Pricing: free during the launch period, then a flat charge per answered
// message. 30000 milli-cents = $0.30 (1 USD = 100,000 milli-cents). Both are
// overridable by env so pricing can change without a code edit.
const DEFAULT_PRICE_MILLI_CENTS = 30000;
const DEFAULT_FREE_UNTIL = '2026-07-22'; // UTC date; free strictly before this.

type PoeEnv = {
  POE_ACCESS_KEY?: string;
  POE_EXTRACTOR_BOT?: string;
  POE_PRICE_MILLI_CENTS?: string;
  POE_FREE_UNTIL?: string;
};

type PoeMessage = { role: string; content: string };
type PoeRequest = {
  version?: string;
  type?: string;
  query?: PoeMessage[];
  message_id?: string;
  user_id?: string;
  conversation_id?: string;
  metadata?: string;
  bot_query_id?: string;
};

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

// --- SSE helpers -----------------------------------------------------------

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...CORS },
  });
}

// A complete text reply: meta, one text block, done.
function textReply(markdown: string): Response {
  return sseResponse(
    sse('meta', { content_type: 'text/markdown', suggested_replies: false }) +
      sse('text', { text: markdown }) +
      sse('done', {}),
  );
}

// An error reply (e.g. insufficient Poe balance to cover the charge).
function errorReply(text: string, errorType?: string): Response {
  return sseResponse(sse('error', { allow_retry: false, text, ...(errorType ? { error_type: errorType } : {}) }));
}

// --- formatting ------------------------------------------------------------

function usd(n: unknown): string {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function pct(n: unknown): string {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  return `${(n * 100).toFixed(1)}%`;
}

// The free interactive tool for each calculator, value-first, re-tagged to
// the Poe attribution bucket. Reuses the canonical /tools slugs from sessions.
function freeToolLink(toolName: string): string {
  const bare = PER_TOOL_FREE_TOOL_BARE[toolName];
  if (!bare) return 'optionsahoy.com/tools';
  return bare.replace('src=mcp_', 'src=poe_');
}

type Result = Record<string, any>;

// Per-tool headline, using the optimizer's own numbers (never the model's).
// Every field access is guarded; an unknown shape falls back to a generic line.
function headline(tool: string, r: Result): string {
  try {
    switch (tool) {
      case 'amt_iso_optimize': {
        const s = r.schedules ?? {};
        const opt = s.optimized ?? {};
        if (typeof opt.nfv !== 'number') break;
        // Only surface the year-by-year schedule when every tranche is a
        // non-negative whole share count; otherwise show the value + link.
        const years: any[] = Array.isArray(opt.years) ? opt.years : [];
        const allClean = years.length > 0 && years.every((y) => typeof y.shares === 'number' && y.shares >= 0);
        const sched = allClean ? years.map((y) => Math.round(y.shares).toLocaleString('en-US')).join(' / ') : '';
        const lines = [`**Optimized after-tax net final value: ${usd(opt.nfv)}**`];
        if (sched) lines.push(`Exercise schedule by year: ${sched} shares.`);
        const lump = usd(s.lumpSum?.nfv);
        const even = usd(s.evenSplit?.nfv);
        if (lump || even) lines.push(`Naive baselines: lump-sum ${lump}, even-split ${even}.`);
        return lines.join('\n\n');
      }
      case 'nso_calculate': {
        const ex = r.exercise ?? {};
        if (typeof ex.total !== 'number') break;
        const lines = [`**Total tax at exercise: ${usd(ex.total)}**`];
        if (ex.netCashSellAll != null) lines.push(`Net cash if you sell all at exercise: ${usd(ex.netCashSellAll)}.`);
        if (r.holdMinusCashless != null) {
          const d = r.holdMinusCashless as number;
          lines.push(`Holding to long-term versus selling and reinvesting: ${d >= 0 ? '+' : ''}${usd(d)} difference.`);
        }
        return lines.join('\n\n');
      }
      case 'rsu_sell_vs_hold': {
        if (typeof r.vest?.total !== 'number' && typeof r.holdMinusSell !== 'number') break;
        const lines = [`**RSU vest: sell-at-vest versus hold**`];
        if (r.vest?.total != null) lines.push(`Tax at vest: ${usd(r.vest.total)}.`);
        if (r.holdMinusSell != null) {
          const d = r.holdMinusSell as number;
          lines.push(`Holding to long-term versus selling at vest: ${d >= 0 ? '+' : ''}${usd(d)} difference, before price risk.`);
        }
        return lines.join('\n\n');
      }
      case 'concentration_analyze': {
        if (typeof r.riskBand !== 'string' && typeof r.concentration !== 'number') break;
        const lines = [`**Single-stock concentration: ${r.riskBand ?? 'analyzed'}**`];
        if (r.concentration != null) lines.push(`This position is ${pct(r.concentration)} of your total assets.`);
        const drop50 = Array.isArray(r.lossExposure) ? r.lossExposure.find((l: any) => l.drop === 0.5 || l.drop === 50) : null;
        if (drop50?.dollarLoss != null) lines.push(`A 50% drop would lose about ${usd(drop50.dollarLoss)}.`);
        return lines.join('\n\n');
      }
      case 'protective_put_price': {
        const rec = r.recommended ?? r.barePut ?? {};
        if (typeof rec.annualCostPct !== 'number' && typeof rec.maxLoss !== 'number') break;
        const lines = [`**Hedge pricing**`];
        if (rec.annualCostPct != null) lines.push(`Annualized hedge cost: about ${pct(rec.annualCostPct)} of the position.`);
        if (rec.maxLoss != null) lines.push(`Maximum loss with the hedge in place: ${usd(rec.maxLoss)}.`);
        return lines.join('\n\n');
      }
      case 'qsbs_check': {
        if (typeof r.verdict !== 'string') break;
        const lines = [`**QSBS verdict: ${r.verdict}**`];
        if (r.exclusionPercent != null) lines.push(`Federal gain exclusion: ${pct(r.exclusionPercent)}.`);
        if (r.excludableGain != null) lines.push(`Excludable gain: ${usd(r.excludableGain)}.`);
        if (r.federalTaxSaved != null) lines.push(`Estimated federal tax saved: ${usd(r.federalTaxSaved)}.`);
        return lines.join('\n\n');
      }
      case 'equity_funding_plan': {
        const rec = r.recommended ?? {};
        if (typeof rec.wealthAtTarget !== 'number') break;
        const lines = [`**Recommended plan to fund the goal**`];
        if (rec.wealthAtTarget != null) lines.push(`Wealth at the target date: ${usd(rec.wealthAtTarget)}.`);
        if (rec.totalTax != null) lines.push(`Total tax: ${usd(rec.totalTax)}.`);
        if (rec.shortfallProbability != null) lines.push(`Shortfall probability: ${pct(rec.shortfallProbability)}.`);
        return lines.join('\n\n');
      }
    }
  } catch {
    // fall through to generic
  }
  return '**Your optimized result is ready.**';
}

// --- parameter extraction (dependency bot) ---------------------------------

// Compact spec of the seven tools for the extractor model: name, first
// sentence of the description, and the required input fields (from the same
// inputSchema the REST + MCP surfaces use).
function toolSpec(): string {
  return TOOLS.map((t) => {
    const purpose = String(t.description).split('. ')[0];
    const schema = t.inputSchema as any;
    const props: string[] = schema.properties ? Object.keys(schema.properties) : [];
    const req: string[] = Array.isArray(schema.required) ? schema.required : [];
    const fields = props.map((p) => (req.includes(p) ? `${p}*` : p)).join(', ');
    return `- ${t.name}: ${purpose}. Fields (*=required): ${fields || 'none'}.`;
  }).join('\n');
}

function extractorPrompt(question: string): string {
  return [
    'You route an equity-compensation question to one OptionsAhoy calculator and extract its inputs.',
    'Do NOT compute anything yourself. Reply with a single JSON object and nothing else.',
    '',
    'Tools:',
    toolSpec(),
    '',
    'Rules:',
    '- If the question fits a tool AND every required (*) field is present or safely inferable, reply {"tool":"<name>","args":{...}} using the exact field names.',
    '- Include EVERY field the user provides, not just the required ones. Map their words to the field names: "17% growth" -> expectedGrowth: 0.17, "0.72 vol" / "volatility 0.72" -> volatility: 0.72, "married" -> filingStatus: "married_joint", "$300k income" -> ordinaryIncome: 300000, percentages as decimals.',
    '- Tools that accept expectedGrowth need EITHER expectedGrowth (a decimal) OR a ticker symbol. If the user gave a growth rate, pass expectedGrowth; if they named a stock, pass ticker. Do not invent a growth rate.',
    '- If a required field is missing and cannot be inferred, reply {"clarify":"<one short question naming the missing fields>"}. Never invent a tax rate, cash return rate, growth rate, or grant date.',
    '- If the question is not about equity-compensation tax planning, reply {"reject":"<one short sentence>"}.',
    '- filingStatus must be one of: single, married_joint, head_household. stateCode is a two-letter code.',
    '',
    `Question: ${question}`,
  ].join('\n');
}

// Parse the text portion of a Poe SSE stream (text events until done/error).
function readSseText(raw: string): { text: string; error?: string } {
  let text = '';
  let error: string | undefined;
  // Poe streams SSE with CRLF line endings; normalize before splitting on the
  // blank-line event separator, then parse each event's type + data lines.
  const norm = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const block of norm.split('\n\n')) {
    let ev: string | null = null;
    let dataStr = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!ev || !dataStr) continue;
    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      continue;
    }
    if (ev === 'text' && typeof data.text === 'string') text += data.text;
    else if (ev === 'error') error = data.text ?? 'dependency error';
  }
  return { text, error };
}

// Pull the first JSON object out of a model reply (handles ```json fences).
function parseJsonObject(s: string): any | null {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Allow tests to inject a fake extractor instead of hitting Poe.
export type Extractor = (question: string) => Promise<any | null>;

async function callExtractor(ctx: PagesContext, req: PoeRequest, question: string): Promise<any | null> {
  const env = (ctx.env ?? {}) as PoeEnv;
  const bot = env.POE_EXTRACTOR_BOT || DEFAULT_EXTRACTOR;
  // Log the failure reason (dependency HTTP status / unparseable reply) to
  // MCP_STATS so it is diagnosable from /admin/mcp-stats without exposing it
  // to the user.
  const fail = (msg: string) => logCall(ctx, { endpoint: 'poe:extract-fail', isError: true, errorMsg: `${bot}: ${msg}`.slice(0, 200), clientName: 'poe' });
  const resp = await fetch(`${POE_BOT_API}${encodeURIComponent(bot)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.POE_ACCESS_KEY ?? ''}`,
    },
    body: JSON.stringify({
      version: PROTOCOL_VERSION,
      type: 'query',
      query: [
        {
          role: 'user',
          content: extractorPrompt(question),
          content_type: 'text/markdown',
          message_id: req.message_id ?? 'm-extract',
          timestamp: 0,
        },
      ],
      message_id: req.message_id ?? 'm-extract',
      user_id: req.user_id ?? '',
      conversation_id: req.conversation_id ?? '',
      metadata: req.metadata ?? '',
      temperature: 0,
    }),
  });
  if (!resp.ok) {
    fail(`http ${resp.status}`);
    return null;
  }
  const { text, error } = readSseText(await resp.text());
  const parsed = parseJsonObject(text);
  if (!parsed) fail(error ? `err ${error}` : `unparseable: ${text.slice(0, 80)}`);
  return parsed;
}

// --- pricing ---------------------------------------------------------------

function priceMilliCents(env: PoeEnv): number {
  const n = Number(env.POE_PRICE_MILLI_CENTS ?? DEFAULT_PRICE_MILLI_CENTS);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// True once the launch free-period has ended and a price is set. During the
// free window we never call the cost API.
function pricingActive(env: PoeEnv): boolean {
  if (priceMilliCents(env) <= 0) return false;
  const freeUntil = Date.parse(`${env.POE_FREE_UNTIL ?? DEFAULT_FREE_UNTIL}T00:00:00Z`);
  if (Number.isFinite(freeUntil) && Date.now() < freeUntil) return false;
  return true;
}

function priceUsd(env: PoeEnv): string {
  return `$${(priceMilliCents(env) / 100000).toFixed(2)}`;
}

// Authorize (hold) or capture (charge) a variable cost on the chatting user.
// Returns true on success. Authorize is called before computing; capture only
// after a successful answer, so users are charged on success.
async function poeCost(
  kind: 'authorize' | 'capture',
  botQueryId: string,
  env: PoeEnv,
  milliCents: number,
  description: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${POE_COST_API}${encodeURIComponent(botQueryId)}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.POE_ACCESS_KEY ?? ''}` },
      body: JSON.stringify({
        amounts: [{ amount_usd_milli_cents: milliCents, description }],
        access_key: env.POE_ACCESS_KEY ?? '',
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// Safe defaults for required fields a user never states in plain English. These
// are conventional "none / still here / standard" values; the extracted args
// always override them. Real inputs (amounts, prices, rates, dates) are NOT
// defaulted, so the bot still asks for those when missing.
const TOOL_DEFAULTS: Record<string, Record<string, unknown>> = {
  amt_iso_optimize: { carryforwardCredit: 0, hasLeftCompany: false, terminationDate: null },
  nso_calculate: { stillEmployed: true, holdFunding: 'cash' },
  rsu_sell_vs_hold: { stillEmployed: true },
  protective_put_price: { protectionLevel: 0.1, tenorYears: 1 },
};

// --- query handling --------------------------------------------------------

const INTRO =
  'Ask an equity-compensation tax question and I return a deterministic, after-tax-optimal answer. ' +
  'For example: "I have 10,000 incentive stock options at a $2 strike, $40 current value, married filing ' +
  'jointly, $300,000 income, California, 4-year horizon, granted 2022-01-01, 5% cash return. Best exercise schedule?" ' +
  'I cover ISO/AMT, NSOs, RSUs, QSBS, single-stock concentration, protective puts, and funding a cash goal from equity.';

async function handleQuery(ctx: PagesContext, req: PoeRequest, extractor?: Extractor): Promise<Response> {
  const env = (ctx.env ?? {}) as PoeEnv;
  // Every request is logged to MCP_STATS as a `poe:*` endpoint with client
  // name "poe" so it shows on the MCP metrics page alongside REST + MCP.
  const log = (f: { endpoint: string; tool?: string; isError?: boolean; errorMsg?: string }) =>
    logCall(ctx, { clientName: 'poe', isError: false, ...f });

  const messages = Array.isArray(req.query) ? req.query : [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = (lastUser?.content ?? '').trim();
  if (!question) {
    log({ endpoint: 'poe:query' });
    return textReply(INTRO);
  }

  let extracted: any | null;
  try {
    extracted = extractor ? await extractor(question) : await callExtractor(ctx, req, question);
  } catch {
    extracted = null;
  }

  if (!extracted) {
    log({ endpoint: 'poe:query' });
    return textReply(
      "I could not parse that into an equity-compensation calculation. Try restating it with the specifics, " +
        "for example the share count, strike, current price, filing status, state, and horizon.\n\n" +
        'You can also use the free tools directly at optionsahoy.com/tools',
    );
  }
  if (typeof extracted.clarify === 'string') {
    log({ endpoint: 'poe:query' });
    return textReply(extracted.clarify);
  }
  if (typeof extracted.reject === 'string') {
    log({ endpoint: 'poe:query' });
    return textReply(`${extracted.reject}\n\nI focus on equity-compensation tax planning. ${INTRO}`);
  }

  const tool = TOOLS.find((t) => t.name === extracted.tool);
  if (!tool) {
    log({ endpoint: 'poe:query' });
    return textReply(INTRO);
  }

  // Charge on success: authorize a hold before computing; capture only after a
  // real answer. During the launch free-period this is a no-op.
  const charge = pricingActive(env) && req.bot_query_id ? priceMilliCents(env) : 0;
  if (charge > 0) {
    const ok = await poeCost('authorize', req.bot_query_id as string, env, charge, `OptionsAhoy ${tool.name}`);
    if (!ok) {
      log({ endpoint: 'poe:query' });
      return errorReply(
        `This bot costs ${priceUsd(env)} per answer, and your Poe balance does not cover it right now. ` +
          `You can also run it free at ${freeToolLink(tool.name)}`,
        'insufficient_fund',
      );
    }
  }

  let result: Result;
  try {
    const args = { ...(TOOL_DEFAULTS[tool.name] ?? {}), ...(extracted.args ?? {}) };
    result = tool.handler(args) as Result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid inputs';
    // Handler failed after authorize: do not capture (the hold expires).
    log({ endpoint: 'poe:tools/call', tool: tool.name, isError: true, errorMsg: msg });
    return textReply(
      `I need a bit more to run that accurately: ${msg}\n\n` +
        `You can also run it yourself, free, at ${freeToolLink(tool.name)}`,
    );
  }

  if (charge > 0) {
    await poeCost('capture', req.bot_query_id as string, env, charge, `OptionsAhoy ${tool.name}`);
  }
  log({ endpoint: 'poe:tools/call', tool: tool.name });

  const body =
    `${headline(tool.name, result)}\n\n` +
    `See the full breakdown, charted, free at ${freeToolLink(tool.name)}\n\n` +
    `_Computed by the OptionsAhoy optimizer against the full federal tax code plus all 50 states and DC. ` +
    `This is the deterministic optimum, not an estimate._`;
  return textReply(body);
}

// --- entry point -----------------------------------------------------------

export const onRequest: PagesFunction = async (ctx: PagesContext): Promise<Response> => {
  const { request } = ctx;
  const env = (ctx.env ?? {}) as PoeEnv;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  // GET/HEAD (a browser visit or a health check) get a friendly 200 so the URL
  // never shows an error. Real Poe traffic is always POST.
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new Response('OptionsAhoy Poe server bot. This endpoint is healthy and speaks the Poe protocol over POST.', {
      status: 200,
      headers: { 'content-type': 'text/plain', ...CORS },
    });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed. Use POST.', { status: 405, headers: CORS });
  }

  // Authenticate against the bot access key (skip only if unconfigured, e.g.
  // first deploy before the secret is set).
  const expected = env.POE_ACCESS_KEY;
  if (expected) {
    const auth = request.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${expected}`) {
      return new Response('Unauthorized', { status: 401, headers: CORS });
    }
  }

  let body: PoeRequest;
  try {
    body = (await request.json()) as PoeRequest;
  } catch {
    return new Response('Invalid JSON', { status: 400, headers: CORS });
  }

  switch (body.type) {
    case 'settings': {
      const active = pricingActive(env);
      const price = priceUsd(env);
      const freeUntil = env.POE_FREE_UNTIL ?? DEFAULT_FREE_UNTIL;
      return new Response(
        JSON.stringify({
          server_bot_dependencies: { [env.POE_EXTRACTOR_BOT || DEFAULT_EXTRACTOR]: 1 },
          allow_attachments: false,
          introduction_message: INTRO,
          content_type: 'text/markdown',
          cost_label: active ? `${price} per message` : 'Free during launch',
          rate_card: active
            ? `Each answer costs **${price}**.`
            : `Free during the launch period (until ${freeUntil}), then **${price}** per answer.`,
        }),
        { status: 200, headers: { 'content-type': 'application/json', ...CORS } },
      );
    }
    case 'query':
      return handleQuery(ctx, body);
    default:
      // report_feedback / report_reaction / report_error and anything else.
      return new Response('', { status: 200, headers: CORS });
  }
};

// Exported for unit tests.
export {
  handleQuery,
  headline,
  freeToolLink,
  parseJsonObject,
  readSseText,
  extractorPrompt,
  pricingActive,
  priceMilliCents,
  priceUsd,
};
