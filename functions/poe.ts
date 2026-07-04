// AlphaLatitude Inc. © 2026
//
// POST /poe — OptionsAhoy as a Poe server bot.
//
// Implements the Poe protocol (version 1.2) directly in a Cloudflare Pages
// Function, no fastapi-poe. Flow per user message:
//   1. Our own cheap model (OpenRouter) maps the natural-language conversation
//      to one of the seven OptionsAhoy calculators and extracts its JSON
//      arguments. Running it on our key (not a Poe dependency bot) costs a
//      fraction of a cent, consumes ZERO user Poe points, returns reliable
//      JSON, and lets us test the live bot without a real Poe session.
//   2. The deterministic OptionsAhoy calculator runs locally (the same TOOLS
//      handlers as /mcp and /api/v1). The MATH IS NEVER done by the language
//      model: it only extracts inputs, and never a fabricated growth rate.
//   3. We format the optimizer's own numbers and stream them back as Poe SSE,
//      with a free-tool link carrying ?src=poe_<tool> for attribution.
//
// Incoming requests are authenticated against POE_ACCESS_KEY (the 32-character
// key Poe issues when the bot is created). Charging (after the launch free
// month) uses the Poe cost API; extraction uses OPENROUTER_API_KEY.

import { TOOLS } from './_lib/mcp-tools';
import { PER_TOOL_FREE_TOOL_BARE } from './_lib/sessions';
import { logCall, logSample } from './_lib/stats';
import { getCurrentPrice } from '../lib/data/prices';
import type { PagesContext, PagesFunction } from './_lib/api';

const POE_COST_API = 'https://api.poe.com/bot/cost/';
// Parameter extraction runs on our own cheap model (OpenRouter), not a Poe
// dependency bot. This costs us a fraction of a cent per query, consumes ZERO
// of the user's Poe points, gives reliable JSON, and lets us test the live bot
// without a real Poe session.
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OR_MODEL = 'openai/gpt-4o-mini';
// Pricing: free during the launch period, then a flat charge per answered
// message. 30000 milli-cents = $0.30 (1 USD = 100,000 milli-cents). Both are
// overridable by env so pricing can change without a code edit.
const DEFAULT_PRICE_MILLI_CENTS = 30000;
const DEFAULT_FREE_UNTIL = '2026-07-22'; // UTC date; free strictly before this.

type PoeEnv = {
  POE_ACCESS_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
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

// "2026-06-24" -> "Jun 2026" for readable sell-schedule dates.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const m = iso.match(/^(\d{4})-(\d{2})/);
  if (!m) return '';
  const mi = parseInt(m[2], 10) - 1;
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${m[1]}` : '';
}

// Sanitize a calc-provided string for the bot voice (no em-dashes).
function clean(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s*—\s*/g, ', ').replace(/–/g, '-') : '';
}

// Recursively drop null / undefined / blank values (including inside nested
// objects like equity_funding stacks and lots) so the calculator's own
// "undefined -> derive from ticker / default" paths take effect. A nested
// `expectedAnnualGrowth: null` would otherwise throw "must be a finite number".
function dropEmpty(v: any): any {
  if (Array.isArray(v)) return v.map(dropEmpty);
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === undefined || val === '') continue;
      out[k] = dropEmpty(val);
    }
    return out;
  }
  return v;
}

// Every number the user actually typed, normalized ($, commas, %, k/m suffixes).
function convoNumbers(convo: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(%|k|m|bn|million|billion)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(convo)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(n)) continue;
    const unit = (m[2] || '').toLowerCase();
    out.push(n);
    if (unit === '%') out.push(n / 100);
    else if (unit === 'k') out.push(n * 1000);
    else if (unit === 'm' || unit === 'million') out.push(n * 1e6);
    else if (unit === 'bn' || unit === 'billion') out.push(n * 1e9);
  }
  return out;
}

// True if v plausibly matches one of the user's stated numbers, allowing the
// percent<->decimal forms (15 vs 0.15).
function stated(v: unknown, nums: number[]): boolean {
  if (typeof v !== 'number' || !isFinite(v)) return false;
  const targets = [v, v * 100, v / 100];
  return nums.some((n) => targets.some((t) => Math.abs(n - t) <= Math.max(1e-9, Math.abs(t) * 1e-6)));
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
        const t = r.timing;
        // An already-closed exercise window (departed and past the post-termination
        // deadline) means unexercised options have likely expired -- never present
        // an exercise plan as if it can still be acted on. (P4)
        const windowClosed = !!(t && (t.windowClosed || (typeof t.daysUntilWindowClose === 'number' && t.daysUntilWindowClose <= 0)));
        const lines: string[] = [];
        if (windowClosed) {
          lines.push('**Your exercise window has already closed, so any unexercised incentive stock options have likely expired.**');
          lines.push('The figures below are informational only. If you already exercised and still hold the shares, the after-tax and credit numbers apply; otherwise treat this as a what-if.');
        } else if (allClean) {
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
              (typeof lump === 'number'
                ? lump >= 0
                  ? `, and far more than exercising everything at once (${usd(lump)}).`
                  : `, and exercising everything at once would actually net a loss of about ${usd(Math.abs(lump))}.`
                : '.'),
          );
        }
        if (typeof opt.exerciseTax === 'number' && opt.exerciseTax > 0) {
          lines.push(
            `These exercises add about ${usd(opt.exerciseTax)} in tax above your normal bill, mostly alternative minimum tax (AMT)` +
              (typeof opt.creditRecovered === 'number' && opt.creditRecovered > 0 ? `, of which roughly ${usd(opt.creditRecovered)} comes back as AMT credit within the plan.` : '.'),
          );
        }
        // Carryforward AMT credit not recovered within the plan window. (P5)
        if (typeof opt.creditRemaining === 'number' && opt.creditRemaining > 0) {
          lines.push(`You would still carry about ${usd(opt.creditRemaining)} of unused AMT credit past the end of the plan, usable against regular tax in later years.`);
        }
        // Holding-period guardrail: ISO shares need the qualifying-disposition
        // hold for the long-term rate.
        if (t && t.qdNotYetEligible && typeof t.qdEligibleDate === 'string') {
          lines.push(`For the lower qualifying rate, hold the exercised shares until ${monthLabel(t.qdEligibleDate)} (two years from grant, one from exercise).`);
        } else if (t && typeof t.daysUntilWindowClose === 'number' && t.daysUntilWindowClose > 0 && t.daysUntilWindowClose < 400) {
          lines.push(`Heads up: your exercise window closes in about ${t.daysUntilWindowClose} days, so unexercised options expire or convert after that.`);
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
          // Disclose the effective sale price the comparison actually used (the
          // expected price trimmed for single-stock volatility), so it does not
          // silently differ from the price the user stated. (P6)
          const eff = r.hold?.effectiveSalePrice;
          const effNote = typeof eff === 'number' ? ` (based on an effective sale price of about ${usd(eff)}, your expected price trimmed for single-stock volatility)` : '';
          lines.push(
            `By your sale date, selling now and reinvesting grows to about ${usd(sell)}, while exercising and holding for the long-term rate reaches about ${usd(hold)}${effNote}. ` +
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
          // A sub-1-year hold is a short-term sale taxed at ordinary rates, not
          // the long-term capital-gains rate. Bind the wording to the engine's
          // isLongTerm so the answer never claims the long-term rate on a cliff.
          const longTerm = r.hold?.isLongTerm !== false;
          const holdPhrase = longTerm
            ? 'holding the shares for the long-term rate'
            : 'holding the shares to your sale date, under a year and taxed at your ordinary rate,';
          // Disclose the effective sale price actually used (expected price
          // trimmed for single-stock volatility), not just the stated one. (P6)
          const eff = r.hold?.effectiveSalePrice;
          const effNote = typeof eff === 'number' ? ` (based on an effective sale price of about ${usd(eff)}, your expected price trimmed for single-stock volatility)` : '';
          lines.push(
            `By your sale date, selling at vest and reinvesting reaches about ${usd(sell)}, while ${holdPhrase} reaches about ${usd(hold)}${effNote}. ` +
              `${d >= 0 ? `Holding wins by about ${usd(d)}` : `Selling wins by about ${usd(-d)}`}, before price risk.`,
          );
          if (!longTerm) {
            lines.push('Heads up: selling under one year from vest is a short-term sale, taxed as ordinary income. Crossing the one-year mark usually drops the rate on the appreciation.');
          }
        }
        return lines.join('\n\n');
      }
      case 'concentration_analyze': {
        if (typeof r.riskBand !== 'string' && typeof r.concentration !== 'number') break;
        const band = typeof r.riskBand === 'string' ? r.riskBand : 'Notable';
        const lines = [`**Single-stock risk level: ${band}.**`];
        if (typeof r.concentration === 'number') {
          lines.push(`This position is ${pct(r.concentration)} of your liquid net worth.` + (typeof r.advisorBenchmarkLine === 'string' ? ` ${clean(r.advisorBenchmarkLine)}` : ''));
        }
        if (Array.isArray(r.lossExposure)) {
          const scen = r.lossExposure
            .filter((l: any) => typeof l.dollarLoss === 'number')
            .map((l: any) => `a ${ratePct(l.drop)} drop costs you about ${usd(l.dollarLoss)}`)
            .join('; ');
          if (scen) lines.push(`What a pullback would cost: ${scen}.`);
        }
        // Sell-down plans: show the wealth-and-tax trade-off between unwinding
        // fast and unwinding slow, with the actual after-tax numbers.
        const sched: any[] = Array.isArray(r.schedule) ? r.schedule : [];
        const plans = sched.filter((p: any) => typeof p.endOfHorizonWealth === 'number' && typeof p.totalTax === 'number');
        if (plans.length >= 2) {
          const fast = plans[0];
          const slow = plans[plans.length - 1];
          const yrs = (p: any) => (Array.isArray(p.yearlySales) ? p.yearlySales.length : 0);
          const label = (n: number) => (n <= 1 ? 'selling it all within a year' : `spreading the sale over ${n} years`);
          const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
          lines.push(
            `${cap(label(yrs(fast)))} leaves about ${usd(fast.endOfHorizonWealth)} after roughly ${usd(fast.totalTax)} in tax; ${label(yrs(slow))} leaves about ${usd(slow.endOfHorizonWealth)} after ${usd(slow.totalTax)}. Selling sooner cuts your single-stock risk faster; the numbers show what each pace does to your tax and ending wealth.`,
          );
        }
        if (typeof r.daysUntilLongTerm === 'number') {
          if (r.daysUntilLongTerm <= 0) {
            lines.push('It already qualifies for the lower long-term capital-gains rate, so a sale now is taxed at the lower rate.');
          } else {
            // Quantify the wait with the engine's dollar saving, not just "worth it".
            const wlt = r.waitForLtInsight;
            const saving = wlt && typeof wlt.savings === 'number' && wlt.savings > 0
              ? ` Waiting that long to sell the whole position would cut your tax by about ${usd(wlt.savings)}.`
              : '';
            lines.push(`Wait about ${r.daysUntilLongTerm} days and it qualifies for the lower long-term capital-gains rate, usually worth it before you sell.${saving}`);
          }
        }
        // Hedging as the alternative to selling.
        const h = r.hedging;
        if (h && typeof h.putPrice === 'number' && typeof h.strike === 'number') {
          lines.push(`Prefer not to sell yet? A one-year put protecting against drops below ${usd(h.strike)} costs about ${usd(h.putPrice)}.`);
        }
        if (typeof r.sectorContextLine === 'string') lines.push(clean(r.sectorContextLine));
        return lines.join('\n\n');
      }
      case 'protective_put_price': {
        const bp = r.barePut ?? {};
        const col = r.collar ?? {};
        if (typeof bp.annualCostPct !== 'number' && typeof bp.maxLoss !== 'number') break;
        const lines = ['**Here are your two ways to protect this position.**'];
        if (typeof bp.maxLoss === 'number') {
          lines.push(
            `Protective put: about ${pct(bp.annualCostPct)} of the position per year (${usd(bp.annualCost)})` +
              (typeof bp.strike === 'number' ? `, puts a floor under your value at ${usd(bp.strike)}` : '') +
              `, caps your loss at about ${usd(bp.maxLoss)}, and keeps all of your upside.`,
          );
        }
        if (typeof col.maxLoss === 'number') {
          const cost = col.isZeroCost ? 'nothing out of pocket' : `about ${usd(col.annualCost)} per year`;
          lines.push(
            `Zero-cost collar: ${cost}` +
              (typeof col.putStrike === 'number' ? `, same floor at ${usd(col.putStrike)}` : '') +
              `, caps your loss at about ${usd(col.maxLoss)}, but limits your upside to about +${pct(col.upsideCapPct)}` +
              (typeof col.capProbability === 'number' ? ` (about a ${pct(col.capProbability)} chance the stock runs past that cap).` : '.'),
          );
        }
        // One recommendation, taken from the engine's own pick, so the value
        // call can never disagree with it. ('none' = neither is clean.)
        if (r.recommended === 'protective-put') {
          lines.push('Our take: the protective put fits best here. It costs more, but it keeps all of your upside while capping the downside.');
        } else if (r.recommended === 'collar') {
          lines.push('Our take: the zero-cost collar is the better value here. It protects the same downside for little or nothing, in exchange for capping your gains above the cap.');
        } else if (r.recommended === 'none') {
          lines.push('Neither is a clean win here: the put is expensive for what it actually covers, and the collar would cap your gains too often. Weigh the trade-off against how much upside you are willing to give up.');
        } else {
          lines.push('The put keeps your full upside for a yearly premium; the collar is cheaper but trades away gains above the cap.');
        }
        // Holding-period tax caution, mirroring the web tool's note.
        lines.push('Tax note: hedging shares you already hold can suspend the holding period and trigger straddle rules under Section 1092, which may affect long-term capital-gains treatment. Confirm with a tax professional before hedging appreciated stock.');
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
              : v === 'too-soon'
                ? '**Not yet, but it is on track to qualify for the QSBS gain exclusion once the holding period is met.**'
                : v === 'caveats'
                  ? '**This likely qualifies for the QSBS gain exclusion, with a couple of items to confirm.**'
                  : '**This does not appear to qualify for the QSBS gain exclusion.**';
        const lines = [verdictLine];
        if (typeof r.exclusionPercent === 'number') lines.push(`Federal exclusion: ${pct(r.exclusionPercent)} of the gain.`);
        if (typeof r.excludableGain === 'number' && r.excludableGain > 0) {
          lines.push(
            `That shields about ${usd(r.excludableGain)} of gain` +
              (typeof r.federalTaxSaved === 'number' ? `, saving roughly ${usd(r.federalTaxSaved)} in federal tax.` : '.'),
          );
        }
        if (typeof r.taxableGain === 'number' && r.taxableGain > 0) {
          // Only attribute the taxable remainder to the cap when the gain
          // genuinely exceeds it (the engine sets cappedOverageNote then). For a
          // tier haircut, too-soon, or a disqualified verdict the cap is not the
          // reason, so no per-company-cap parenthetical.
          const cappedOverage = typeof r.cappedOverageNote === 'string' && r.cappedOverageNote.length > 0;
          lines.push(
            `About ${usd(r.taxableGain)} of gain stays taxable` +
              (cappedOverage && typeof r.applicableCap === 'number'
                ? ` (your gain tops the ${usd(r.applicableCap)} per-company exclusion cap, so the excess is taxable no matter how long you hold).`
                : '.'),
          );
        }
        // Name the specific tests that are blocking or pending, the actionable
        // part the web tool shows as a checklist.
        const tests: any[] = Array.isArray(r.tests) ? r.tests : [];
        const blocking = tests.filter((t: any) => t.status === 'fail');
        const waiting = tests.filter((t: any) => t.status === 'wait');
        const unsure = tests.filter((t: any) => t.status === 'unsure' || t.status === 'not-sure');
        if (blocking.length) {
          lines.push(`What is blocking it: ${blocking.map((t: any) => `${String(t.label).toLowerCase()} (${clean(t.detail)})`).join('; ')}`);
        } else if (waiting.length) {
          lines.push(`Just a matter of time: ${waiting.map((t: any) => clean(t.detail)).join('; ')}`);
        }
        if (unsure.length) lines.push(`Confirm these with a tax professional before relying on it: ${unsure.map((t: any) => String(t.label).toLowerCase()).join(', ')}.`);
        if (typeof r.stateNote === 'string') lines.push(clean(r.stateNote));
        if (!waiting.length && typeof r.yearsUntilFullExclusion === 'number' && r.yearsUntilFullExclusion > 0) {
          lines.push(`Hold about ${r.yearsUntilFullExclusion} more year(s) to reach the full exclusion.`);
        }
        return lines.join('\n\n');
      }
      case 'equity_funding_plan': {
        const rec = r.recommended ?? {};
        if (typeof rec.wealthAtTarget !== 'number') break;
        const plan = rec.plan ?? {};
        const lines: string[] = [];
        // The actual sell schedule: how many shares to sell on each date.
        // Show every sale, not a summary -- this is the whole point of the answer.
        const sched: any[] = Array.isArray(plan.schedule) ? plan.schedule : [];
        const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);
        const steps = sched
          .map((row: any) => {
            const iso = String(row?.saleDateISO ?? '');
            const m = iso.match(/^(\d{4})-(\d{2})/);
            const shares = Array.isArray(row?.sales) ? row.sales.reduce((a: number, s: any) => a + num(s?.shares), 0) : 0;
            const tickers = Array.isArray(row?.sales) ? [...new Set(row.sales.map((s: any) => s?.ticker).filter(Boolean))] : [];
            return m ? { year: m[1], when: `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}`, shares, tickers } : null;
          })
          .filter((s): s is { year: string; when: string; shares: number; tickers: string[] } => !!s && s.shares > 0);
        const total = num(plan.totalSharesSold) || steps.reduce((a, s) => a + s.shares, 0);
        const goal = usd(plan.targetAfterTax ?? rec.targetAfterTax);
        const multiTicker = new Set(steps.flatMap((s) => s.tickers)).size > 1;
        const line = (s: { when: string; shares: number; tickers: string[] }) =>
          `- ${s.when}: sell ${s.shares.toLocaleString('en-US')} shares` + (multiTicker && s.tickers.length ? ` (${s.tickers.join(', ')})` : '');
        // Render the dated schedule under a header: list every sale when there
        // are few enough, else group by year (still exact). Returns [] for an
        // empty schedule so the caller supplies its own line.
        const renderSchedule = (header: string): string[] => {
          if (steps.length === 0) return [];
          if (steps.length <= 16) return [header, steps.map(line).join('\n')];
          const byYear = new Map<string, { shares: number; n: number; first: string; last: string }>();
          for (const s of steps) {
            const g = byYear.get(s.year) ?? { shares: 0, n: 0, first: s.when, last: s.when };
            g.shares += s.shares;
            g.n += 1;
            g.last = s.when;
            byYear.set(s.year, g);
          }
          return [
            header,
            [...byYear.entries()]
              .map(([y, g]) => `- ${y}: sell ${g.shares.toLocaleString('en-US')} shares across ${g.n} sales (${g.first} to ${g.last})`)
              .join('\n'),
          ];
        };

        // If the goal can't be reached even selling everything by the deadline,
        // lead with the shortfall and frame the schedule as the most that can be
        // raised. Never render an unreachable goal as a success.
        if (plan.feasible === false) {
          const sf = plan.shortfall ?? {};
          const maxAfterTax = num(sf.maxAchievableAfterTax) || num(rec.wealthAtTarget);
          const gap = num(sf.gap) || Math.max(0, num(plan.targetAfterTax ?? rec.targetAfterTax) - maxAfterTax);
          lines.push(`**Your ${goal} goal is more than this equity can net by your deadline.**`);
          lines.push(...renderSchedule(`Selling everything you hold, ${total.toLocaleString('en-US')} shares, is the most you can raise:`));
          lines.push(
            `That nets about ${usd(maxAfterTax)} after tax, roughly ${usd(gap)} short of ${goal}. To close the gap you would need more shares, more time, or a lower target.`,
          );
          return lines.join('\n\n');
        }

        if (steps.length === 0) {
          lines.push('**Here is the plan to reach your goal.**');
        } else {
          lines.push(...renderSchedule(`**Your sell schedule, ${total.toLocaleString('en-US')} shares in total to net ${goal} after tax:**`));
        }
        // Why this plan: max expected wealth subject to the shortfall tolerance.
        lines.push(
          `Of the plans that keep your risk of missing the ${usd(plan.targetAfterTax ?? rec.targetAfterTax)} goal within tolerance, this leaves the most expected wealth: about ${usd(rec.wealthAtTarget)} at your deadline` +
            (typeof rec.totalTax === 'number' ? `, after about ${usd(rec.totalTax)} in taxes` : '') +
            (typeof rec.shortfallProbability === 'number' ? `, with about a ${pct(rec.shortfallProbability)} chance of still falling short.` : '.'),
        );
        // The position you keep after the plan (the schedule sells only part). (P10)
        if (typeof plan.remainingShares === 'number' && plan.remainingShares > 0) {
          lines.push(
            `After the plan you would still hold about ${Math.round(plan.remainingShares).toLocaleString('en-US')} shares` +
              (typeof plan.remainingPositionValue === 'number' && plan.remainingPositionValue > 0 ? `, worth roughly ${usd(plan.remainingPositionValue)} at today's price.` : '.'),
          );
        }
        // The trade-off across the named alternatives.
        const opt: string[] = [];
        const li = r.lockInNow;
        const ba = r.balanced;
        const hg = r.holdForGrowth;
        if (li && typeof li.wealthAtTarget === 'number') opt.push(`sell everything now for about ${usd(li.wealthAtTarget)} at ${pct(li.shortfallProbability || 0)} shortfall risk`);
        if (ba && typeof ba.wealthAtTarget === 'number') opt.push(`spread the sales for about ${usd(ba.wealthAtTarget)} at ${pct(ba.shortfallProbability || 0)} risk`);
        if (hg && typeof hg.wealthAtTarget === 'number') opt.push(`hold for growth for about ${usd(hg.wealthAtTarget)} at ${pct(hg.shortfallProbability || 0)} risk`);
        if (opt.length) lines.push(`The trade-off, safe to aggressive: ${opt.join('; ')}. Holding longer can grow the pot but raises the odds of missing the goal.`);
        return lines.join('\n\n');
      }
    }
  } catch {
    // fall through to generic
  }
  return '**Your optimized result is ready.**';
}

// Disclose the forward-looking assumptions the answer rests on (growth,
// volatility, sale price, hold period), so the user knows what drove it and can
// change them. Built from the args actually passed to the calculator.
function assumptionsLine(tool: string, a: Record<string, any>): string {
  const parts: string[] = [];
  const tk = typeof a.ticker === 'string' ? a.ticker.toUpperCase() : '';
  switch (tool) {
    case 'amt_iso_optimize':
    case 'concentration_analyze': {
      const rate = tool === 'amt_iso_optimize' ? a.expectedGrowth : a.expectedPositionReturn;
      const word = tool === 'amt_iso_optimize' ? 'growth' : 'return';
      if (tk) {
        parts.push(`annual ${word} and volatility from ${tk}'s historical returns`);
      } else {
        if (typeof rate === 'number') parts.push(`${ratePct(rate)} expected annual ${word}`);
        parts.push(typeof a.volatility === 'number' ? `${a.volatility} volatility` : 'a default volatility for the stock');
      }
      break;
    }
    case 'nso_calculate':
    case 'rsu_sell_vs_hold': {
      if (tk) parts.push(`a future price from ${tk}'s historical returns`);
      else if (typeof a.expectedSalePrice === 'number') parts.push(`an expected sale price of ${usd(a.expectedSalePrice)}`);
      if (typeof a.holdYears === 'number') parts.push(`a ${a.holdYears}-year hold`);
      break;
    }
    case 'protective_put_price': {
      parts.push(typeof a.volatility === 'number' ? `${a.volatility} volatility` : "volatility from the sector's history");
      if (typeof a.tenorYears === 'number') parts.push(`a ${a.tenorYears}-year tenor`);
      break;
    }
    case 'equity_funding_plan': {
      parts.push("each holding's growth and volatility (from your numbers, or its ticker's history)");
      break;
    }
    // qsbs_check has no forward-looking assumptions (dates + amounts only).
  }
  return parts.length ? `Assumptions: ${parts.join(', ')}. Give me a ticker or different numbers to change these.` : '';
}

// --- parameter extraction (dependency bot) ---------------------------------

// Compact spec of the seven tools for the extractor model: name, first
// sentence of the description, and the required input fields (from the same
// inputSchema the REST + MCP surfaces use).
function toolSpec(): string {
  return TOOLS.map((t) => {
    const desc = String(t.description);
    const purpose = desc.split('. ')[0];
    const schema = t.inputSchema as any;
    const props = schema.properties ?? {};
    const req: string[] = Array.isArray(schema.required) ? schema.required : [];
    const fields = Object.keys(props).map((p) => (req.includes(p) ? `${p}*` : p)).join(', ');
    // Enum constraints the model must use verbatim (e.g. sector, filingStatus).
    const enums = Object.entries(props)
      .filter(([, v]: any) => Array.isArray(v.enum))
      .map(([k, v]: any) => `${k}=[${v.enum.join('|')}]`);
    // The concrete example from the description shows exact value formats and
    // nested structure (e.g. equity_funding's `stacks`). STRICT_INPUT_NOTE has
    // no braces, so the last "}" closes the example object.
    let example = '';
    const exFrom = desc.search(/Example(?: call)?:/);
    if (exFrom >= 0) {
      const open = desc.indexOf('{', exFrom);
      const close = desc.lastIndexOf('}');
      if (open >= 0 && close > open) example = desc.slice(open, close + 1);
    }
    let line = `- ${t.name}: ${purpose}. Fields (*=required): ${fields || 'none'}.`;
    if (enums.length) line += ` Allowed values: ${enums.join(', ')}.`;
    if (example) line += ` Example args: ${example}`;
    return line;
  }).join('\n');
}

function extractorPrompt(conversation: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    'You route an equity-compensation chat to one OptionsAhoy calculator and extract its inputs.',
    'Do NOT compute anything yourself. Reply with a single JSON object and nothing else.',
    `Today is ${today} (UTC). Resolve every relative date ("next summer", "in two years", "by June") against it, and never emit a deadline in the past.`,
    '',
    'Tools:',
    toolSpec(),
    '',
    'Rules:',
    '- This is a multi-turn chat. The user often answers your earlier follow-up question in a later turn (for example you asked for a ticker and they reply "nvda"). Combine EVERY detail from the WHOLE conversation into one args object; do not treat the latest line in isolation.',
    '- A later turn usually just ADJUSTS one parameter (for example "what about 2% shortfall risk?", "make it single filer", "same as above"). When it does, KEEP every field already established in earlier turns -- the ticker, share counts, cost basis, dates, income, state, filing status -- and only change what the new turn states. Never drop the stock/ticker or re-ask for something an earlier turn already gave or that a ticker derives.',
    '- If the chat fits a tool AND every required (*) field is present or safely inferable, reply {"tool":"<name>","args":{...}} using the exact field names.',
    '- Include EVERY field the user provides, not just the required ones. Map their words to the field names: "17% growth" -> expectedGrowth: 0.17, "0.72 vol" / "volatility 0.72" -> volatility: 0.72, "married" -> filingStatus: "married_joint", "$300k income" -> ordinaryIncome: 300000, percentages as decimals. When the user names a stock ("my NVDA position", "I hold AAPL", "5,000 NVDA shares"), set ticker to that symbol (e.g. "NVDA").',
    '- Some tools need a forward estimate -- expectedGrowth for ISOs, expectedPositionReturn for concentration, expectedSalePrice for NSOs, and for equity_funding each stack\'s expectedAnnualGrowth and volatility -- OR a ticker symbol to derive it. A TICKER IS SUFFICIENT: when a stock\'s ticker is present, its growth, volatility, and price are derived automatically, so do NOT ask for them and do NOT clarify for a growth/return rate. For equity_funding, a stack with a ticker (e.g. {ticker:"AMZN", lots:[...]}) needs no expectedAnnualGrowth or volatility from you. Only when there is NEITHER a rate NOR a ticker, reply {"clarify":"ask for an expected annual growth rate (e.g. 10%) or a ticker"}. Never invent a growth rate, and NEVER reuse cashReturnRate (the return on idle cash) as the stock growth. Do not output a placeholder ticker like "unknown"; omit ticker if you do not have a real symbol.',
    '- If required fields are missing and cannot be inferred, reply {"clarify":"<one short, friendly question naming EVERYTHING you need>"} -- list every missing field in that single question so the user is not asked twice. Never invent a tax rate, cash return rate, growth rate, or grant date.',
    '- If the user asks what you can do, what inputs you need, or how to use you (instead of giving a scenario), reply {"help":"<the tool name if they asked about a specific one, otherwise general>"}.',
    '- If the chat is not about equity-compensation tax planning at all, reply {"reject":"<one short sentence>"}.',
    '- Do NOT confuse prices. currentPrice/fmv is the value NOW: phrases like "$40 value", "$40 current value", "$200 value", "now $140", "trading at $140", "currently $200", "worth $X" all set currentPrice/fmv. A purchase price ("bought at $60", "paid $60", cost basis, strike) is a PAST price; it is costBasisPerShare / adjustedBasis / strike, NEVER currentPrice/fmv. If the ONLY price the user gives is a purchase/cost price (no current value), OMIT currentPrice/fmv entirely (do not output 0 or null, and do not reuse the purchase price).',
    '- filingStatus must be one of: single, married_joint, head_household. stateCode is a two-letter code.',
    '- assetCategory maps the company\'s stated GROSS ASSETS AT ISSUANCE to a bucket: under $50 million -> "under-50m" (so "$8M in assets" -> "under-50m"); $50M to $75M -> "50m-to-75m"; above $75M -> "over-75m"; not stated -> "unsure". Never confuse the expected GAIN with the company\'s assets.',
    '',
    'Conversation so far (resolve the latest user turn using all earlier turns):',
    conversation,
  ].join('\n');
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

// Allow tests to inject a fake extractor instead of hitting Poe. Receives the
// recent conversation transcript, not just the latest message.
export type Extractor = (conversation: string) => Promise<any | null>;

async function callExtractor(ctx: PagesContext, _req: PoeRequest, conversation: string): Promise<any | null> {
  const env = (ctx.env ?? {}) as PoeEnv;
  // Failure reason -> MCP_STATS so it is diagnosable from /admin/mcp-stats.
  const fail = (msg: string) => logCall(ctx, { endpoint: 'poe:extract-fail', isError: true, errorMsg: msg.slice(0, 200), clientName: 'poe' });
  const key = env.OPENROUTER_API_KEY;
  if (!key) {
    fail('no OPENROUTER_API_KEY configured');
    return null;
  }
  const model = env.OPENROUTER_MODEL || DEFAULT_OR_MODEL;
  try {
    const resp = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: extractorPrompt(conversation) }],
      }),
    });
    if (!resp.ok) {
      fail(`http ${resp.status}`);
      return null;
    }
    const j: any = await resp.json();
    const content = j?.choices?.[0]?.message?.content ?? '';
    const parsed = parseJsonObject(content);
    if (!parsed) fail(`unparseable: ${String(content).slice(0, 80)}`);
    return parsed;
  } catch (e) {
    fail(`exception ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
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
  amt_iso_optimize: { carryforwardCredit: 0, hasLeftCompany: false, terminationDate: null, cashReturnRate: 0.05 },
  nso_calculate: { stillEmployed: true, holdFunding: 'cash' },
  rsu_sell_vs_hold: { stillEmployed: true, holdYears: 1 },
  protective_put_price: { protectionLevel: 0.1, tenorYears: 1 },
};

// --- query handling --------------------------------------------------------

// Plain-language guidance for help / capability questions.
const FRIENDLY: Record<string, string> = {
  amt_iso_optimize: 'plan an incentive stock option (ISO) exercise schedule around the alternative minimum tax (AMT)',
  nso_calculate: 'analyze a non-qualified stock option (NSO) exercise, sell versus hold',
  rsu_sell_vs_hold: 'compare selling versus holding restricted stock units (RSUs) at vest',
  concentration_analyze: 'measure single-stock concentration risk and your ways out',
  protective_put_price: 'price a hedge (a protective put or a zero-cost collar)',
  qsbs_check: 'check qualified small business stock (QSBS) eligibility',
  equity_funding_plan: 'plan how to fund a cash goal from your equity by a deadline',
};
const HELP_EXAMPLE: Record<string, string> = {
  amt_iso_optimize: '"10,000 ISOs, $2 strike, $40 value, married filing jointly, $300k income, CA, 4-year horizon, granted 2022-01-01, 5% cash, 12% growth. Best schedule?"',
  nso_calculate: '"Exercise and hold or sell 5,000 NSOs at $10 strike, $50 price, single, $180k income, CA, hold 2 years, ticker AAPL?"',
  rsu_sell_vs_hold: '"1,000 RSUs vesting at $100, single, $200k income, CA, hold 2 years, ticker MSFT. Sell at vest or hold?"',
  concentration_analyze: '"My NVDA is $400k of my $1.2M, cost basis $100k, bought 2022-01-01, single, $200k income, CA. How risky?"',
  protective_put_price: '"Hedge a $400k tech-software position at 10% protection for 1 year?"',
  qsbs_check: '"C-corp founder stock bought 2020-01-15 for $100k, selling for $5M, original issuance, under $50M, tech, active, single, $250k income, CA. Do I qualify for QSBS?"',
  equity_funding_plan: '"Need $400k after tax by 2028-06-01 from 4,000 NVDA bought at $60 in 2023, now $140, 15% growth, married filing jointly, $280k income, CA. Plan?"',
};

// User-facing labels for each input field. Built per tool FROM the inputSchema so
// the required/optional menu cannot drift from what the calculator accepts.
// Empty label = hidden (folded into a per-tool note or internal-only).
const FIELD_LABELS: Record<string, string> = {
  shares: 'number of shares', strike: 'strike price', fmv: 'current share value',
  currentPrice: 'current price', filingStatus: 'filing status', ordinaryIncome: 'annual income',
  stateCode: 'state', carryforwardCredit: 'AMT credit carryforward', horizon: 'planning horizon in years',
  cashReturnRate: 'cash return rate', grantDate: 'grant date', hasLeftCompany: "whether you've left the company",
  terminationDate: '', expectedGrowth: 'expected annual growth rate', ticker: 'ticker symbol',
  volatility: 'volatility', stillEmployed: "whether you're still employed", holdYears: 'years to hold',
  holdFunding: 'cash vs sell-to-cover funding', expectedSalePrice: 'expected sale price',
  expectedMarketReturn: 'expected market return', positionValue: 'position value', costBasis: 'cost basis',
  acquisitionDate: 'purchase date', sector: 'sector', totalAssets: 'total investable assets',
  expectedPositionReturn: 'expected annual return', hedgeChoice: 'hedge choice (put or collar)',
  protectionLevel: 'downside protection level', tenorYears: 'tenor in years', expectedReturn: 'expected return',
  tickerLabel: '', saleDate: 'sale date', entityType: 'entity type', acquisitionMethod: 'how you acquired the shares',
  assetCategory: 'company gross-asset size', industry: 'industry', activeBusiness: 'active-business answer',
  adjustedBasis: 'adjusted basis', expectedGain: 'expected gain', targetAfterTax: 'after-tax cash goal',
  targetDate: 'deadline', stacks: '', lots: '', expectedAnnualGrowth: '', cashInterestRate: 'cash interest rate',
  riskToleranceShortfall: 'risk tolerance (max shortfall chance)', defaultVolatility: 'default volatility',
};

// Schema-required fields the bot safely assumes when unstated (see TOOL_DEFAULTS).
// Shown under Optional with the assumption so the user knows the default.
// Schema-required fields the Poe bot safely assumes when unstated (TOOL_DEFAULTS).
// Shown under Optional with the assumption so the user knows the default. NOTE:
// the MCP/REST API still requires these; the assumption is a Poe-bot convenience.
const ASSUMED_LABEL: Record<string, Record<string, string>> = {
  amt_iso_optimize: { carryforwardCredit: 'assumes none', hasLeftCompany: 'assumes still employed', terminationDate: '', cashReturnRate: 'assumes 5%' },
  nso_calculate: { stillEmployed: 'assumes still employed', holdFunding: 'assumes cash exercise' },
  rsu_sell_vs_hold: { stillEmployed: 'assumes still employed', holdYears: 'assumes a 1-year hold' },
  protective_put_price: { protectionLevel: 'assumes 10%', tenorYears: 'assumes 1 year' },
};

// The "give a ticker or supply these" alternative. The Poe bot fills the current
// price and the forward estimate (and volatility) from a ticker snapshot, so
// those fields are not hard-required even though the raw API schema lists some of
// them as required. Appended to Required as one clause.
const REQUIRED_NOTE: Record<string, string> = {
  amt_iso_optimize: 'and a ticker, or the current share value and an expected growth rate',
  nso_calculate: 'and a ticker, or the current price and an expected sale price',
  rsu_sell_vs_hold: 'and a ticker, or the current price and an expected sale price',
  concentration_analyze: 'and a ticker, or an expected annual return',
  equity_funding_plan: 'and your holdings: for each lot the shares, cost basis, and purchase date, with a ticker or current price',
};
// Fields folded into REQUIRED_NOTE (the ticker-or alternative) -- excluded from
// BOTH the Required and Optional lists. Includes price fields the schema marks
// required but the Poe bot derives from a ticker (fmv, currentPrice).
const EXCLUDE: Record<string, Set<string>> = {
  amt_iso_optimize: new Set(['fmv', 'expectedGrowth', 'ticker']),
  nso_calculate: new Set(['currentPrice', 'expectedSalePrice', 'ticker']),
  rsu_sell_vs_hold: new Set(['currentPrice', 'expectedSalePrice', 'ticker']),
  concentration_analyze: new Set(['expectedPositionReturn', 'ticker']),
  protective_put_price: new Set(['ticker', 'tickerLabel']),
  equity_funding_plan: new Set(['stacks', 'lots', 'currentPrice', 'expectedAnnualGrowth']),
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Split a tool's inputSchema into the user-facing required vs optional parameter
// lists (defaulted-required fields move to optional with their assumption).
function toolParams(tool: string): { required: string[]; optional: string[] } {
  const t = TOOLS.find((x) => x.name === tool);
  const s = (t?.inputSchema ?? {}) as { required?: string[]; properties?: Record<string, unknown> };
  const req = Array.isArray(s.required) ? s.required : [];
  const props = Object.keys(s.properties ?? {});
  const assumed = ASSUMED_LABEL[tool] ?? {};
  const exclude = EXCLUDE[tool] ?? new Set<string>();
  const label = (f: string) => FIELD_LABELS[f] ?? f;
  const required = req.filter((f) => !(f in assumed) && !exclude.has(f)).map(label).filter(Boolean);
  const optional = [
    ...req.filter((f) => f in assumed && label(f)).map((f) => `${label(f)} (${assumed[f]})`),
    ...props.filter((p) => !req.includes(p) && !exclude.has(p)).map(label).filter(Boolean),
  ];
  return { required, optional };
}

// One menu entry per tool: purpose + Required + Optional.
function toolMenuLine(tool: string): string {
  const p = toolParams(tool);
  const req = p.required.join(', ') + (REQUIRED_NOTE[tool] ? `, ${REQUIRED_NOTE[tool]}` : '');
  const opt = p.optional.length ? p.optional.join(', ') : 'none';
  return `- ${cap(FRIENDLY[tool])}\n   Required: ${req}.\n   Optional: ${opt}.`;
}

function capabilitiesMenu(): string {
  return Object.keys(FRIENDLY).map(toolMenuLine).join('\n');
}

// Help / capability answer. A specific tool name gives that tool's required +
// optional inputs and an example; anything else gives the full menu.
function helpText(topic: string): string {
  if (FRIENDLY[topic]) {
    const p = toolParams(topic);
    const req = p.required.join(', ') + (REQUIRED_NOTE[topic] ? `, ${REQUIRED_NOTE[topic]}` : '');
    const opt = p.optional.length ? p.optional.join(', ') : 'none';
    return `To ${FRIENDLY[topic]}:\n\nRequired: ${req}.\nOptional: ${opt}.\n\nExample: ${HELP_EXAMPLE[topic]}`;
  }
  return (
    'I turn an equity-compensation question into a deterministic, after-tax-optimal answer. Here is each calculator with its required and optional inputs:\n\n' +
    capabilitiesMenu() +
    `\n\nExample question: ${HELP_EXAMPLE.amt_iso_optimize}\n\nGive me the details in plain English and I compute the optimal plan. Give a ticker and I derive growth, volatility, and price. The first answer is on the house during launch.`
  );
}

const INTRO =
  'I turn an equity-compensation tax question into a deterministic, after-tax-optimal answer. ' +
  'Here are the seven calculators and the inputs each one needs (give a ticker and I derive growth, volatility, and price):\n\n' +
  capabilitiesMenu() +
  `\n\nExample: ${HELP_EXAMPLE.amt_iso_optimize}\n\nAsk in plain English. The first answer is on the house during launch.`;

async function handleQuery(ctx: PagesContext, req: PoeRequest, extractor?: Extractor): Promise<Response> {
  const env = (ctx.env ?? {}) as PoeEnv;
  // Every request is logged to MCP_STATS as a `poe:*` endpoint with client
  // name "poe" so it shows on the MCP metrics page alongside REST + MCP.
  const log = (f: { endpoint: string; tool?: string; isError?: boolean; errorMsg?: string }) =>
    logCall(ctx, { clientName: 'poe', isError: false, ...f });

  const messages = Array.isArray(req.query) ? req.query : [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser || !(lastUser.content ?? '').trim()) {
    log({ endpoint: 'poe:query' });
    return textReply(INTRO);
  }

  // Pass the recent transcript, not just the last message, so the extractor can
  // resolve follow-ups: when we ask for a ticker and the user replies "nvda",
  // it must combine that with the original scenario from an earlier turn.
  const convo = messages
    .filter((m) => (m.role === 'user' || m.role === 'bot') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`)
    .join('\n');
  // User turns only, for the anti-fabrication guard: numbers in OUR OWN
  // greeting/help/answers (the intro embeds a worked example with "12% growth,
  // granted 2022-01-01") must never count as user-stated.
  const userText = messages
    .filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => m.content.trim())
    .join('\n');

  let extracted: any | null;
  try {
    extracted = extractor ? await extractor(convo) : await callExtractor(ctx, req, convo);
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
  if (typeof extracted.help !== 'undefined') {
    log({ endpoint: 'poe:help' });
    return textReply(helpText(typeof extracted.help === 'string' ? extracted.help : 'general'));
  }
  if (typeof extracted.reject === 'string') {
    log({ endpoint: 'poe:query' });
    // Fixed lead-in: the model's own reject sentence occasionally garbles
    // (dropping a "not"), so never echo it to the user.
    return textReply(`That is outside what I cover.\n\nI focus on equity-compensation tax planning. ${INTRO}`);
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
  let usedArgs: Record<string, any> = {};
  let priceNote = '';
  try {
    // Drop null/undefined/blank values (recursively, including inside stacks)
    // the extractor emitted for fields the user did not state, so the safe
    // defaults and the calculator's ticker-derivation take effect. An explicit
    // null would otherwise override a default (carryforwardCredit: 0) or throw
    // ("stacks[0].expectedAnnualGrowth must be a finite number").
    if (extracted.args !== undefined && (typeof extracted.args !== 'object' || extracted.args === null || Array.isArray(extracted.args))) {
      throw new Error('extractor returned a non-object args payload');
    }
    const provided: Record<string, any> = dropEmpty(extracted.args ?? {});
    // Drop a placeholder/implausible ticker the model sometimes emits
    // ("unknown", "n/a", a whole phrase). A real symbol is 1-6 letters.
    if (typeof provided.ticker === 'string' && !/^[A-Za-z][A-Za-z.\-]{0,5}$/.test(provided.ticker.trim())) {
      delete provided.ticker;
    }
    // Benign date normalization: users answer "2023" or "2023-06" to a
    // when-was-it-granted ask; the engine wants a full ISO date. Pinning to
    // Jan 1 / the 1st adds no invented tax fact. Applies to top-level date
    // fields and to equity_funding's nested lots.
    const normDate = (v: unknown, deadline: boolean): unknown => {
      const y = typeof v === 'number' && Number.isInteger(v) && v >= 1900 && v <= 2100
        ? String(v)
        : typeof v === 'string' && /^\d{4}$/.test(v.trim()) ? v.trim() : null;
      if (y) return deadline ? `${y}-12-31` : `${y}-01-01`;
      if (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v.trim())) {
        return deadline ? `${v.trim()}-28` : `${v.trim()}-01`;
      }
      return v;
    };
    for (const k of ['grantDate', 'acquisitionDate', 'saleDate', 'targetDate', 'terminationDate']) {
      if (k in provided) provided[k] = normDate(provided[k], k === 'targetDate');
    }
    if (Array.isArray(provided.stacks)) {
      for (const st of provided.stacks) {
        if (st && Array.isArray(st.lots)) {
          for (const lot of st.lots) {
            if (lot && 'acquisitionDate' in lot) lot.acquisitionDate = normDate(lot.acquisitionDate, false);
            if (lot && 'vestDate' in lot) lot.vestDate = normDate(lot.vestDate, false);
          }
        }
      }
    }
    // A grantDate with NO date wording anywhere in the user's text is the
    // extractor inventing one (usually copied from the worked example). Strip
    // it and ask. Any year, month name, or relative-date phrase counts as
    // date wording; this never blocks a date the user actually gave.
    const DATE_WORDING = /\b(19|20)\d{2}\b|january|february|march|april|may|june|july|august|september|october|november|december|years? ago|last year|next year|granted (in|on|last)/i;
    if (typeof provided.grantDate === 'string' && !DATE_WORDING.test(userText)) {
      delete provided.grantDate;
    }
    // The extractor sometimes answers boolean fields with "yes"/"no" strings;
    // the engine requires real booleans. Coerce the unambiguous cases.
    for (const k of ['hasLeftCompany', 'stillEmployed']) {
      if (typeof provided[k] === 'string') {
        const t = provided[k].trim().toLowerCase();
        if (t === 'yes' || t === 'true') provided[k] = true;
        else if (t === 'no' || t === 'false') provided[k] = false;
      }
    }
    // "Sell at vest or hold?" often extracts holdYears 0; below the engine's
    // 0.25 minimum it would throw. Drop it so the disclosed 1-year default
    // (TOOL_DEFAULTS) applies instead of a validation error.
    if (tool.name === 'rsu_sell_vs_hold' && typeof provided.holdYears === 'number' && provided.holdYears <= 0) {
      delete provided.holdYears;
    }
    // The current date is the server's to know, never the model's. The extractor
    // (its training cutoff in the past) otherwise emits a stale `today` that
    // anchors equity_funding's schedule years before the real date. Always drop
    // it so the engine uses the real clock. ("today" is a test-only hook on the
    // shared input schema; no consumer turn should set it.)
    delete provided.today;
    // Anti-fabrication: a price or forward rate the model supplied must actually
    // appear in the user's text. Otherwise the model fills currentPrice / growth
    // / volatility from its own knowledge of a named stock (e.g. NVDA ~ $140) --
    // a made-up tax assumption presented as fact. Strip any value the user did
    // not state; the bot then asks for it, or (for growth/vol when a ticker is
    // given) derives it from the bundled trailing snapshot.
    const nums = convoNumbers(userText);
    for (const k of ['currentPrice', 'fmv', 'positionValue', 'expectedSalePrice', 'expectedGrowth', 'expectedPositionReturn', 'volatility']) {
      if (typeof provided[k] === 'number' && !stated(provided[k], nums)) delete provided[k];
    }
    if (Array.isArray(provided.stacks)) {
      for (const s of provided.stacks) {
        if (!s) continue;
        for (const k of ['currentPrice', 'expectedAnnualGrowth', 'volatility']) {
          if (typeof s[k] === 'number' && !stated(s[k], nums)) delete s[k];
        }
        // Also drop a price that is non-positive or exactly a lot's cost basis
        // (the model mislabeling the purchase price as the current price).
        if (
          typeof s.currentPrice === 'number' &&
          (s.currentPrice <= 0 || (Array.isArray(s.lots) && s.lots.some((l: any) => l?.costBasisPerShare === s.currentPrice)))
        ) {
          delete s.currentPrice;
        }
      }
    }
    if (
      tool.name === 'concentration_analyze' &&
      typeof provided.positionValue === 'number' &&
      typeof provided.costBasis === 'number' &&
      provided.positionValue === provided.costBasis
    ) {
      delete provided.positionValue;
    }
    // Deterministic ticker follow-up: if we just asked for a ticker and the
    // user's reply is a lone symbol (e.g. "nvda"), use it -- the model is
    // unreliable on such terse one-word turns.
    const lastBot = [...messages].reverse().find((m) => m.role === 'bot');
    const lastUserText = (lastUser.content ?? '').trim();
    if (!provided.ticker && /^[A-Za-z]{1,5}$/.test(lastUserText) && lastBot && /ticker/i.test(lastBot.content ?? '')) {
      provided.ticker = lastUserText.toUpperCase();
    }
    // Suggest a current price from the ticker (a dated snapshot, like the web
    // tools' prefill) so the user need not type one. Disclosed + overridable.
    const PX_FIELD: Record<string, string> = { amt_iso_optimize: 'fmv', nso_calculate: 'currentPrice', rsu_sell_vs_hold: 'currentPrice' };
    const pxField = PX_FIELD[tool.name];
    if (pxField && typeof provided.ticker === 'string' && typeof provided[pxField] !== 'number') {
      const px = getCurrentPrice(provided.ticker);
      if (px) {
        provided[pxField] = px.price;
        priceNote = `Using ${provided.ticker.toUpperCase()} at ${usd(px.price)} as of ${px.asOf} (tell me if that is off).`;
      }
    }
    if (tool.name === 'equity_funding_plan' && Array.isArray(provided.stacks)) {
      const notes: string[] = [];
      for (const s of provided.stacks) {
        if (s && typeof s.ticker === 'string' && typeof s.currentPrice !== 'number') {
          const px = getCurrentPrice(s.ticker);
          if (px) {
            s.currentPrice = px.price;
            notes.push(`${s.ticker.toUpperCase()} at ${usd(px.price)}`);
          }
        }
      }
      if (notes.length) priceNote = `Using ${notes.join(', ')} as of the latest snapshot (tell me if that is off).`;
    }
    const args = { ...(TOOL_DEFAULTS[tool.name] ?? {}), ...provided };
    usedArgs = args;
    result = tool.handler(args) as Result;
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'invalid inputs';
    // Handler failed after authorize: do not capture (the hold expires).
    log({ endpoint: 'poe:tools/call', tool: tool.name, isError: true, errorMsg: raw });
    // The common case is a missing forward estimate (growth/return/sale price).
    // Ask for it plainly and lead with the easy option (a ticker). Otherwise
    // fall back to the engine hint, stripped of its model-facing meta sentence.
    const field = raw.match(/field\s+"([^"]+)"/i)?.[1] ?? '';
    const FORWARD = new Set(['expectedGrowth', 'volatility', 'expectedPositionReturn', 'expectedSalePrice']);
    // Current-value fields the user must supply: the engine is offline and does
    // not look up live quotes, so it cannot invent a price.
    const PRICE_ASK: Record<string, string> = {
      currentPrice: 'what the stock is trading at now (the current price per share)',
      fmv: 'the current fair market value per share',
      positionValue: 'what the position is worth right now',
    };
    // Plain asks for date fields whose value was missing or malformed. The raw
    // engine hint ("must be an ISO date string") is model-facing and doubly
    // confusing next to ISO = incentive stock option.
    const DATE_ASK: Record<string, string> = {
      grantDate: 'when the options were granted. A year is fine, for example 2023',
      acquisitionDate: 'when you acquired the shares. A year is fine, for example 2022',
      saleDate: 'when you plan to sell (for example 2027-06-01)',
      targetDate: 'when you need the cash by, as a future date (for example 2027-06-01)',
      vestDate: 'when the shares vested. A year is fine, for example 2024',
      terminationDate: 'when you left the company (for example 2026-03-15)',
    };
    let ask: string;
    if (FORWARD.has(field)) {
      // A missing forward estimate. One ticker-first ask covering everything the
      // engine derives from a symbol, so the user does not get asked twice.
      if (tool.name === 'amt_iso_optimize' || tool.name === 'concentration_analyze') {
        const word = tool.name === 'amt_iso_optimize' ? 'growth' : 'return';
        ask = `Almost there. Give me the stock's ticker and I will use its historical ${word} and volatility, or tell me both an expected annual ${word} rate (for example 10%) and a volatility (for example 0.5).`;
      } else {
        ask = `Almost there. Give me the stock's ticker and I will project the price, or tell me the price you expect to sell at.`;
      }
    } else if (PRICE_ASK[field]) {
      ask = `Almost there. Tell me ${PRICE_ASK[field]}. I work from the price you give, not a live quote.`;
    } else if (DATE_ASK[field]) {
      ask = `Almost there. Tell me ${DATE_ASK[field]}.`;
    } else if (field && FIELD_LABELS[field]) {
      // Any other named-field validation failure: ask for the field by its
      // user-facing label instead of leaking the schema wording. Labels that
      // are already clauses ("whether you've left the company") skip "your".
      const label = FIELD_LABELS[field];
      ask = `Almost there. Tell me ${label.startsWith('whether') ? label : `your ${label}`}.`;
    } else if (/json|non-object/i.test(raw)) {
      ask = 'I could not read that into a calculation. Try restating it with the specifics, for example the share count, strike, current price, filing status, state, and horizon.';
    } else {
      const m = raw.match(/required:\s*([\s\S]*)/i);
      const hint = clean((m ? m[1] : raw).split(/\.\s*The model/i)[0]).trim();
      ask = `To run this accurately I need a bit more: ${hint}.`;
    }
    return textReply(`${ask}\n\nYou can also run it yourself${pricingActive(env) ? '' : ' free'} at ${freeToolLink(tool.name)}`);
  }

  if (charge > 0) {
    await poeCost('capture', req.bot_query_id as string, env, charge, `OptionsAhoy ${tool.name}`);
  }
  log({ endpoint: 'poe:tools/call', tool: tool.name });

  // Closing call to action. While the bot is free, point to the matching free
  // web tool (funnel). Once the bot charges, do NOT advertise the free tool
  // that reproduces this same answer; point to the broader beta instead, so the
  // paid answer is not undercut.
  const cta = pricingActive(env)
    ? `Want this across your whole equity position, not just one question? That is the OptionsAhoy beta: optionsahoy.com/beta?src=poe`
    : `See the full year-by-year breakdown, charted, and try your own numbers free at ${freeToolLink(tool.name)}`;
  const assume = assumptionsLine(tool.name, usedArgs);
  const body =
    `${headline(tool.name, result)}\n\n` +
    (priceNote ? `${priceNote}\n\n` : '') +
    (assume ? `${assume}\n\n` : '') +
    `${cta}\n\n` +
    `_Worked out by the OptionsAhoy optimizer across the full federal tax code plus all 50 states and DC, not estimated._`;
  // Capture this successful answer as an example (7-day rolling, admin-gated) so
  // we can see what people actually ask and what we return.
  logSample(ctx, { surface: 'poe', tool: tool.name, clientName: 'poe', query: convo, answer: body });
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
          // No Poe dependency bots: parameter extraction runs on our own model.
          server_bot_dependencies: {},
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
  extractorPrompt,
  pricingActive,
  priceMilliCents,
  priceUsd,
  helpText,
  toolSpec,
};
