// AlphaLatitude Inc. © 2026
//
// A2A (Agent2Agent) interface for the OptionsAhoy Equity Planner.
//
// Other agents discover this agent from its Agent Card
// (/.well-known/agent-card.json) and delegate equity-compensation questions
// to it over the A2A JSON-RPC transport (POST /a2a, method message/send).
//
// DETERMINISTIC BY DESIGN: every inbound message is routed to one of the
// seven keyless calculators by an explicit `skill` id carried in a data
// part. No language model is invoked, so the hosted endpoint has no
// per-call inference cost. Free-text messages get a keyword-routed pointer
// to the matching skill and its input schema, again with no model in the
// loop.
//
// The seven calculators are the exact same parser + compute pairs the
// /api/v1/* REST endpoints use, so an A2A answer is byte-identical to the
// REST answer for the same input.

import {
  parseAmtIsoInput,
  parseNsoInput,
  parseRsuInput,
  parseConcentrationInput,
  parseProtectivePutInput,
  parseQsbsInput,
  parseEquityFundingInput,
} from './calc-parsers';
import { computeAmtIso } from '../../lib/calc/amtIso';
import { computeNsoResult } from '../../lib/calc/nso';
import { computeRsuResult } from '../../lib/calc/rsu';
import { calculate as calculateConcentration } from '../../lib/calc/concentration';
import { calculateProtectivePut } from '../../lib/calc/protectivePut';
import { evaluateQsbs } from '../../lib/calc/qsbs';
import { computeEquityFundingComparison } from '../../lib/calc/equityFunding';

// The public endpoint advertised in the Agent Card. The card is served at
// optionsahoy.com/.well-known/agent-card.json and the JSON-RPC endpoint at
// optionsahoy.com/a2a (both reach this Pages project through the edge proxy).
export const AGENT_URL = 'https://optionsahoy.com/a2a';
export const PROTOCOL_VERSION = '0.3.0';
export const AGENT_VERSION = '0.1.0';

// One skill per calculator. `id` is the calculator's tool name (and the
// `skill` value an A2A caller sends); `rest` is the equivalent REST path so
// a caller can read the full input schema; `keywords` drive the no-model
// free-text router; `run` parses then computes, reusing the REST pairs.
export interface Skill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  rest: string;
  keywords: string[];
  run: (input: unknown) => unknown;
}

export const SKILLS: Skill[] = [
  {
    id: 'amt_iso',
    name: 'ISO exercise and AMT optimizer',
    description:
      'Optimize a multi-year incentive stock option (ISO) exercise schedule under the alternative minimum tax (AMT).',
    tags: ['iso', 'amt', 'exercise-timing', 'equity-compensation', 'tax'],
    examples: [
      'When and how many of my 20,000 incentive stock options should I exercise over 4 years to minimize alternative minimum tax?',
    ],
    rest: '/api/v1/amt-iso',
    keywords: [
      'incentive stock option',
      'alternative minimum tax',
      ' iso ',
      ' amt ',
      'exercise schedule',
    ],
    run: (input) => computeAmtIso(parseAmtIsoInput(input)),
  },
  {
    id: 'nso',
    name: 'NSO exercise tax',
    description:
      'Compute the tax and after-tax proceeds of exercising non-qualified stock options (NSOs) and holding versus selling.',
    tags: ['nso', 'non-qualified-stock-options', 'tax'],
    examples: [
      'How much tax will I owe if I exercise 5,000 non-qualified stock options, and should I sell at exercise or hold?',
    ],
    rest: '/api/v1/nso',
    keywords: ['non-qualified', 'nonqualified', 'non qualified', ' nso '],
    run: (input) => computeNsoResult(parseNsoInput(input)),
  },
  {
    id: 'rsu_sell_vs_hold',
    name: 'RSU sell-versus-hold',
    description:
      'Compare selling vested restricted stock units (RSUs) at vest against holding them, on an after-tax, risk-adjusted basis.',
    tags: ['rsu', 'vesting', 'capital-gains'],
    examples: [
      'My restricted stock units just vested. Should I sell now or hold for long-term capital gains?',
    ],
    rest: '/api/v1/rsu-sell-vs-hold',
    keywords: ['restricted stock unit', ' rsu ', 'just vested', 'sell or hold'],
    run: (input) => computeRsuResult(parseRsuInput(input)),
  },
  {
    id: 'concentration',
    name: 'Single-stock concentration analysis',
    description:
      'Analyze a concentrated single-stock position and the after-tax cost of diversifying it.',
    tags: ['concentration', 'single-stock-risk', 'hedging'],
    examples: [
      "Eighty percent of my net worth is in one company's stock. How much should I sell down?",
    ],
    rest: '/api/v1/concentration',
    keywords: ['concentrated', 'concentration', 'single stock', 'diversify', 'sell down'],
    run: (input) => calculateConcentration(parseConcentrationInput(input)),
  },
  {
    id: 'protective_put',
    name: 'Protective put and collar pricing',
    description:
      'Price a protective put hedge for a stock position at a given downside protection level and tenor.',
    tags: ['hedging', 'protective-put', 'zero-cost-collar', 'options-pricing'],
    examples: ['What would a protective put or a zero-cost collar on my 10,000 shares cost?'],
    rest: '/api/v1/protective-put',
    keywords: ['protective put', 'collar', 'hedge', 'hedging', 'downside protection'],
    run: (input) => calculateProtectivePut(parseProtectivePutInput(input)),
  },
  {
    id: 'qsbs',
    name: 'QSBS Section 1202 check',
    description:
      'Check qualified small business stock (QSBS) eligibility and the resulting federal and state capital-gains exclusion.',
    tags: ['qsbs', 'section-1202', 'tax-exclusion'],
    examples: ['Do my shares qualify for the Section 1202 qualified small business stock exclusion?'],
    rest: '/api/v1/qsbs',
    keywords: ['qsbs', 'section 1202', ' 1202', 'qualified small business'],
    run: (input) => evaluateQsbs(parseQsbsInput(input)),
  },
  {
    id: 'equity_funding',
    name: 'Fund a cash goal from equity',
    description:
      'Plan which equity lots to sell, and when, to fund a cash goal by a target date with the least after-tax cost.',
    tags: ['equity-funding', 'liquidity', 'planning'],
    examples: [
      'I need 200,000 dollars after tax for a down payment in 2 years. What should I sell and when?',
    ],
    rest: '/api/v1/equity-funding',
    keywords: ['down payment', 'cash goal', 'fund a', 'raise cash', 'liquidity'],
    run: (input) => computeEquityFundingComparison(parseEquityFundingInput(input)),
  },
];

const SKILL_BY_ID: Record<string, Skill> = Object.fromEntries(SKILLS.map((s) => [s.id, s]));

// The A2A Agent Card. camelCase keys, the shape an A2A 0.3.x client expects
// at /.well-known/agent-card.json. The committed static card must match this
// (a drift test asserts it); both are served from the same SKILLS source.
export function buildAgentCard(url: string = AGENT_URL): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    name: 'OptionsAhoy Equity Planner',
    description:
      'Answers equity-compensation planning questions by calling the OptionsAhoy calculators: ' +
      'incentive stock option and alternative minimum tax (AMT) exercise timing, non-qualified ' +
      'stock options, restricted stock unit sell-versus-hold, qualified small business stock ' +
      '(QSBS), single-stock concentration, protective-put hedging, and funding a cash goal from ' +
      'equity. The financial math is deterministic and verifiable ' +
      "(https://optionsahoy.com/verification); OptionsAhoy's API is keyless. Send a message " +
      'with a data part {"skill":"<id>","input":{...}} to run a calculator.',
    url,
    preferredTransport: 'JSONRPC',
    version: AGENT_VERSION,
    provider: { organization: 'AlphaLatitude Inc.', url: 'https://optionsahoy.com' },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    documentationUrl: 'https://optionsahoy.com/for-agents',
    iconUrl: 'https://optionsahoy.com/icon.png',
    skills: SKILLS.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
      examples: s.examples,
    })),
  };
}

// ---- A2A message construction ----

export interface A2APart {
  kind: 'text' | 'data';
  text?: string;
  data?: unknown;
}
export interface A2AMessage {
  role: 'agent';
  parts: A2APart[];
  messageId: string;
  kind: 'message';
}

function messageId(): string {
  return crypto.randomUUID();
}

export function agentMessage(text: string, data?: unknown): A2AMessage {
  const parts: A2APart[] = [{ kind: 'text', text }];
  if (data !== undefined) parts.push({ kind: 'data', data });
  return { role: 'agent', parts, messageId: messageId(), kind: 'message' };
}

const VERIFY_NOTE =
  'The financial math is deterministic and verifiable at https://optionsahoy.com/verification.';

function skillList(): string {
  return SKILLS.map((s) => s.id).join(', ');
}

// No-model free-text router: pick the first skill whose keywords appear in
// the text. Padded with spaces so short tokens like "iso"/"amt" match whole
// words, not substrings of unrelated words.
export function routeByKeyword(text: string): Skill | null {
  const t = ` ${text.toLowerCase()} `;
  for (const s of SKILLS) {
    if (s.keywords.some((k) => t.includes(k))) return s;
  }
  return null;
}

// Route one inbound user message (the parts of params.message) to a reply.
// Returns the agent message plus the skill id that ran (for telemetry), or
// null skill when nothing was computed.
export function handleMessage(parts: A2APart[]): { message: A2AMessage; skill: string | null } {
  const dataPart = parts.find(
    (p) => p.kind === 'data' && p.data !== null && typeof p.data === 'object',
  );

  if (dataPart) {
    const data = dataPart.data as Record<string, unknown>;
    const skillId = data.skill;
    if (typeof skillId !== 'string' || !(skillId in SKILL_BY_ID)) {
      return {
        message: agentMessage(
          `Unknown or missing "skill". Send a data part {"skill":"<id>","input":{...}} for one ` +
            `of: ${skillList()}.`,
        ),
        skill: null,
      };
    }
    const skill = SKILL_BY_ID[skillId];
    try {
      const result = skill.run(data.input);
      return {
        message: agentMessage(`OptionsAhoy ${skill.name} result. ${VERIFY_NOTE}`, result),
        skill: skill.id,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        message: agentMessage(
          `The OptionsAhoy ${skill.name} calculator could not run that input: ${msg}. The full ` +
            `input schema is at https://optionsahoy.com${skill.rest} and ` +
            `https://optionsahoy.com/openapi.json.`,
        ),
        skill: null,
      };
    }
  }

  // No data part: keyword-route the free text to a skill and explain how to
  // call it. Still no language model.
  const text = parts
    .filter((p) => p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join(' ')
    .trim();

  const matched = text ? routeByKeyword(text) : null;
  if (matched) {
    return {
      message: agentMessage(
        `This looks like a question for the "${matched.name}" skill. Send a data part ` +
          `{"skill":"${matched.id}","input":{...}} to run it. The input fields are documented at ` +
          `https://optionsahoy.com${matched.rest} and https://optionsahoy.com/openapi.json. ${VERIFY_NOTE}`,
      ),
      skill: null,
    };
  }

  return {
    message: agentMessage(
      `This agent runs the OptionsAhoy calculators on structured input. Send a data part ` +
        `{"skill":"<id>","input":{...}} for one of: ${skillList()}. Input schemas: ` +
        `https://optionsahoy.com/openapi.json. ${VERIFY_NOTE}`,
    ),
    skill: null,
  };
}
