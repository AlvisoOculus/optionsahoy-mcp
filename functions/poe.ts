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

// Round a rate to a whole percent for bracket talk (0.24 -> "24%").
function ratePct(n: unknown): string {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  return `${Math.round(n * 100)}%`;
}

// Sanitize a calc-provided string for the bot voice (no em-dashes).
function clean(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s*—\s*/g, ', ').replace(/–/g, '-') : '';
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
        const years: any[] = Array.isArray(opt.years) ? opt.years : [];
        const allClean = years.length > 0 && years.every((y) => typeof y.shares === 'number' && y.shares >= 0);
        const lines: string[] = [];
        if (allClean) {
          const plan = years
            .map((y) => `${Math.round(y.shares).toLocaleString('en-US')} in year ${y.year}`)
            .join(', ');
          lines.push(`**Exercise your incentive stock options like this: ${plan}.**`);
        } else {
          lines.push('**Here is your tax-optimal exercise plan.**');
        }
        lines.push(
          `Spreading the exercises this way leaves you with the most money after taxes: about ${usd(opt.nfv)} at the end of your plan.`,
        );
        const even = s.evenSplit?.nfv;
        const lump = s.lumpSum?.nfv;
        if (typeof even === 'number' && opt.nfv - even > 0) {
          lines.push(
            `That is roughly ${usd(opt.nfv - even)} more than exercising the same shares in equal amounts each year (${usd(even)})` +
              (typeof lump === 'number' ? `, and far more than exercising everything at once (${usd(lump)}).` : '.'),
          );
        }
        return lines.join('\n\n');
      }
      case 'nso_calculate': {
        const ex = r.exercise ?? {};
        if (typeof ex.total !== 'number') break;
        const lines = [`**Exercising these options would trigger about ${usd(ex.total)} in tax right now.**`];
        const parts: string[] = [];
        if (typeof ex.federal === 'number') parts.push(`${usd(ex.federal)} federal`);
        if (typeof ex.state === 'number') parts.push(`${usd(ex.state)} state`);
        const fica = (ex.socialSecurity || 0) + (ex.medicare || 0) + (ex.additionalMedicare || 0);
        if (fica > 0) parts.push(`${usd(fica)} payroll tax`);
        if (parts.length) lines.push(`That is ${parts.join(', ')}.`);
        if (typeof ex.netCashSellAll === 'number') lines.push(`Exercise and sell every share and you keep about ${usd(ex.netCashSellAll)} in cash after tax.`);
        const sell = r.sellNowInvest?.netAtYearN;
        const hold = r.hold?.netAtYearN;
        if (typeof sell === 'number' && typeof hold === 'number') {
          const d = hold - sell;
          lines.push(
            `By your sale date, selling now and reinvesting grows to about ${usd(sell)}, while exercising and holding for the long-term rate reaches about ${usd(hold)}. ` +
              `${d >= 0 ? `Holding wins by about ${usd(d)}` : `Selling wins by about ${usd(-d)}`}, before price risk.`,
          );
        }
        const bj = r.bracketJump;
        if (bj && typeof bj.fromRate === 'number' && typeof bj.toRate === 'number' && bj.toRate > bj.fromRate) {
          lines.push(`Note: this exercise pushes part of the gain from the ${ratePct(bj.fromRate)} bracket into the ${ratePct(bj.toRate)} bracket.`);
        }
        return lines.join('\n\n');
      }
      case 'rsu_sell_vs_hold': {
        const v = r.vest ?? {};
        if (typeof v.total !== 'number' && typeof r.holdMinusSell !== 'number') break;
        const lines: string[] = [];
        if (typeof v.total === 'number') {
          lines.push(`**These vesting shares trigger about ${usd(v.total)} in tax, leaving roughly ${usd(v.netCashAtVest)} after tax.**`);
        } else {
          lines.push('**Here is your sell-at-vest versus hold comparison.**');
        }
        if (typeof v.federal === 'number' && typeof v.federalWithheldAtVest === 'number') {
          const short = v.federal - v.federalWithheldAtVest;
          if (short > 1000) {
            lines.push(`Watch the withholding gap: your employer holds back about ${usd(v.federalWithheldAtVest)} for federal tax, but you actually owe about ${usd(v.federal)}. Set aside roughly ${usd(short)} for April.`);
          }
        }
        const sell = r.sellNowInvest?.netAtYearN;
        const hold = r.hold?.netAtYearN;
        if (typeof sell === 'number' && typeof hold === 'number') {
          const d = hold - sell;
          lines.push(
            `By your sale date, selling at vest and reinvesting reaches about ${usd(sell)}, while holding the shares for the long-term rate reaches about ${usd(hold)}. ` +
              `${d >= 0 ? `Holding wins by about ${usd(d)}` : `Selling wins by about ${usd(-d)}`}, before price risk.`,
          );
        }
        return lines.join('\n\n');
      }
      case 'concentration_analyze': {
        if (typeof r.riskBand !== 'string' && typeof r.concentration !== 'number') break;
        const band = typeof r.riskBand === 'string' ? r.riskBand : 'Notable';
        const lines = [`**Single-stock risk level: ${band}.**`];
        if (typeof r.concentration === 'number') lines.push(`It is ${pct(r.concentration)} of everything you own.`);
        if (Array.isArray(r.lossExposure)) {
          const scen = r.lossExposure
            .filter((l: any) => typeof l.dollarLoss === 'number')
            .map((l: any) => `a ${ratePct(l.drop)} drop loses about ${usd(l.dollarLoss)}`)
            .join('; ');
          if (scen) lines.push(`Downside scenarios: ${scen}.`);
        }
        if (typeof r.daysUntilLongTerm === 'number') {
          lines.push(
            r.daysUntilLongTerm <= 0
              ? 'It already qualifies for the lower long-term capital-gains rate.'
              : `It reaches the lower long-term rate in about ${r.daysUntilLongTerm} days, which is worth waiting for if you can.`,
          );
        }
        if (typeof r.sectorContextLine === 'string') lines.push(clean(r.sectorContextLine));
        lines.push('Your three ways to manage it, sell down, hold, or hedge, are compared after tax side by side in the tool.');
        return lines.join('\n\n');
      }
      case 'protective_put_price': {
        const bp = r.barePut ?? {};
        const col = r.collar ?? {};
        if (typeof bp.annualCostPct !== 'number' && typeof bp.maxLoss !== 'number') break;
        const lines = ['**Here are your two ways to protect this position.**'];
        if (typeof bp.maxLoss === 'number') {
          lines.push(
            `Protective put: costs about ${pct(bp.annualCostPct)} of the position per year (${usd(bp.annualCost)}), caps your loss at about ${usd(bp.maxLoss)}, and keeps all of your upside.`,
          );
        }
        if (typeof col.maxLoss === 'number') {
          const cost = col.isZeroCost ? 'nothing out of pocket' : `about ${usd(col.annualCost)} per year`;
          lines.push(
            `Zero-cost collar: costs ${cost}, caps your loss at about ${usd(col.maxLoss)}, but limits your upside to about +${pct(col.upsideCapPct)}.`,
          );
        }
        lines.push('The put keeps your full upside for a yearly premium; the collar is cheaper but trades away gains above the cap.');
        return lines.join('\n\n');
      }
      case 'qsbs_check': {
        if (typeof r.verdict !== 'string') break;
        const v = r.verdict;
        const verdictLine =
          v === 'qualifies'
            ? '**Good news: this looks like it qualifies for the QSBS gain exclusion.**'
            : v === 'partial'
              ? '**This partially qualifies for the QSBS gain exclusion.**'
              : '**This does not appear to qualify for the QSBS gain exclusion.**';
        const lines = [verdictLine];
        if (typeof r.exclusionPercent === 'number') lines.push(`Federal exclusion: ${pct(r.exclusionPercent)} of the gain.`);
        if (typeof r.excludableGain === 'number') {
          lines.push(
            `That shields about ${usd(r.excludableGain)} of gain` +
              (typeof r.federalTaxSaved === 'number' ? `, saving roughly ${usd(r.federalTaxSaved)} in federal tax.` : '.'),
          );
        }
        if (typeof r.taxableGain === 'number' && r.taxableGain > 0) lines.push(`About ${usd(r.taxableGain)} of gain sits above the cap and stays taxable.`);
        if (typeof r.stateNote === 'string') lines.push(clean(r.stateNote));
        if (typeof r.yearsUntilFullExclusion === 'number' && r.yearsUntilFullExclusion > 0) {
          lines.push(`Hold about ${r.yearsUntilFullExclusion} more year(s) to reach the full exclusion.`);
        }
        return lines.join('\n\n');
      }
      case 'equity_funding_plan': {
        const rec = r.recommended ?? {};
        if (typeof rec.wealthAtTarget !== 'number') break;
        const lines = [
          `**Recommended plan: reach about ${usd(rec.wealthAtTarget)} by your deadline` +
            (typeof rec.totalTax === 'number' ? `, after about ${usd(rec.totalTax)} in taxes` : '') +
            (typeof rec.shortfallProbability === 'number' ? `, with about a ${pct(rec.shortfallProbability)} chance of falling short.` : '.') +
            '**',
        ];
        const opt: string[] = [];
        const li = r.lockInNow;
        const ba = r.balanced;
        const hg = r.holdForGrowth;
        if (li && typeof li.wealthAtTarget === 'number') opt.push(`sell now for about ${usd(li.wealthAtTarget)} with ${pct(li.shortfallProbability || 0)} risk of falling short`);
        if (ba && typeof ba.wealthAtTarget === 'number') opt.push(`spread the sales for about ${usd(ba.wealthAtTarget)} at ${pct(ba.shortfallProbability || 0)} risk`);
        if (hg && typeof hg.wealthAtTarget === 'number') opt.push(`hold for growth for about ${usd(hg.wealthAtTarget)} at ${pct(hg.shortfallProbability || 0)} risk`);
        if (opt.length) lines.push(`Your choices run from safe to aggressive: ${opt.join('; ')}. The recommended plan is the most you can expect while keeping the shortfall risk near your tolerance.`);
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
        `You can also run it yourself${pricingActive(env) ? '' : ' free'} at ${freeToolLink(tool.name)}`,
    );
  }

  if (charge > 0) {
    await poeCost('capture', req.bot_query_id as string, env, charge, `OptionsAhoy ${tool.name}`);
  }
  log({ endpoint: 'poe:tools/call', tool: tool.name });

  const freeWord = pricingActive(env) ? '' : ' free';
  const body =
    `${headline(tool.name, result)}\n\n` +
    `See the full year-by-year breakdown, charted, and try your own numbers${freeWord} at ${freeToolLink(tool.name)}\n\n` +
    `_Worked out by the OptionsAhoy optimizer across the full federal tax code plus all 50 states and DC, not estimated._`;
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
