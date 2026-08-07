// AlphaLatitude Inc. © 2026
//
// End-to-end test of the local stdio MCP server: spawn it, send a
// JSON-RPC handshake + tools/list + tools/call over stdin, parse
// responses from stdout. Validates that the stdio entry point exposes
// the same TOOLS / RESOURCES / PROMPTS surface as the hosted HTTP
// endpoint.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { SERVER_INSTRUCTIONS } from '../functions/_lib/mcp-instructions';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, '..', 'src', 'stdio-server.ts');
const SERVER_CWD = path.resolve(__dirname, '..');

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

type Pending = {
  id: number;
  resolve: (r: JsonRpcResponse) => void;
  reject: (err: Error) => void;
};

// Long-lived stdio session reused across all the per-tool tests. Spawning
// the server once instead of per-test cuts the suite from ~20s to ~2s.
class StdioSession {
  child!: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending: Pending[] = [];
  private nextId = 1;

  async start() {
    this.child = spawn('npx', ['tsx', SERVER_ENTRY], {
      cwd: SERVER_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk) => this.onChunk(chunk));
    this.child.stderr.on('data', () => {});
    // If the child dies, reject every in-flight request so tests fail loudly
    // instead of hanging until each per-request timer fires.
    this.child.on('exit', (code, signal) => {
      const pending = this.pending;
      this.pending = [];
      for (const p of pending) {
        p.reject(new Error(`child exited (code=${code}, signal=${signal}) before responding to id=${p.id}`));
      }
    });

    // Handshake.
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    this.notify('notifications/initialized');
    return init;
  }

  stop() {
    this.child.kill();
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p.id !== id);
        reject(new Error(`timeout waiting for ${method} (id=${id})`));
      }, 8000);
      this.pending.push({
        id,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  private onChunk(chunk: Buffer) {
    this.buffer += chunk.toString();
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.id == null) continue;
      const match = this.pending.find((p) => p.id === parsed.id);
      if (match) {
        this.pending = this.pending.filter((p) => p !== match);
        match.resolve(parsed);
      }
    }
  }
}

describe('local stdio MCP server', () => {
  const session = new StdioSession();
  let initResult: { protocolVersion: string; instructions?: string };

  beforeAll(async () => {
    const init = await session.start();
    initResult = init.result as { protocolVersion: string; instructions?: string };
    expect(initResult.protocolVersion).toBe('2024-11-05');
  }, 15000);

  afterAll(() => {
    session.stop();
  });

  // Transport parity: the stdio server used to be constructed with no
  // `instructions` at all, so npx / the MCPB bundle / Zed silently lost the
  // routing and input-discipline guidance the hosted endpoint sends. That gap
  // only started to matter once the tool descriptions were trimmed to pure
  // descriptions for the Anthropic directory review, which moved the
  // "never invent an input" contract here.
  it('serves the same instructions the hosted endpoint does', () => {
    expect(initResult.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it('instructions carry the input-discipline contract', () => {
    const i = SERVER_INSTRUCTIONS;
    expect(i).toContain('Input discipline, the rule that matters most');
    // The tools range-check but cannot provenance-check, so the model has to be
    // told to ask rather than guess. Keep these three commitments in the text.
    expect(i).toMatch(/never invent an input value/);
    expect(i).toMatch(/ask the user for that specific field before calling/);
    // The reason the model cannot lean on the error path: omission errors,
    // fabrication does not.
    expect(i).toMatch(/cannot tell a supplied figure from a guessed one/);
    expect(i).toMatch(/pass `unsure` rather than guessing/);
    // The kinds of optional field. Collapsing these into one rule either
    // invites invented numbers or makes the model interrogate the user about
    // fields that carry a documented default. An earlier two-kinds version
    // stranded terminationDate (required only once hasLeftCompany is true)
    // and the pure enhancers (ticker, tickerLabel, hedgeChoice).
    expect(i).toMatch(/come in a few kinds/);
    expect(i).toMatch(/pure enhancers/);
    expect(i).toMatch(/Omit those, do not ask the user for them/);
    expect(i).toMatch(/still need a real value/);
    expect(i).toMatch(/terminationDate once hasLeftCompany is true/);
    // The income contract changes what the model must ASK for, so it has to
    // live here and not only in the parameter descriptions.
    expect(i).toMatch(/taxable income after deductions, not gross wages/);
  });

  it('lists all eight tools', async () => {
    const res = await session.request('tools/list');
    const tools = (res.result as {
      tools: Array<{
        name: string;
        description: string;
        outputSchema?: { type: string; properties: Record<string, unknown> };
      }>;
    }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'amt_iso_optimize',
      'concentration_analyze',
      'equity_funding_plan',
      'nso_calculate',
      'protective_put_price',
      'qsbs_check',
      'rsu_lot_optimize',
      'rsu_sell_vs_hold',
    ]);
    // Every tool has the input-discipline note appended and an outputSchema
    // describing its structured result (required by OpenAI's app scanner).
    for (const t of tools) {
      expect(t.description).toContain('built-in default');
      expect(t.outputSchema).toBeDefined();
      expect(t.outputSchema!.type).toBe('object');
      expect(Object.keys(t.outputSchema!.properties).length).toBeGreaterThan(0);
    }
  });

  it('lists all eight resources', async () => {
    const res = await session.request('resources/list');
    const resources = (res.result as { resources: Array<{ uri: string }> }).resources;
    expect(resources).toHaveLength(8);
    for (const r of resources) {
      expect(r.uri.startsWith('https://optionsahoy.com/')).toBe(true);
    }
  });

  it('reads a resource', async () => {
    const res = await session.request('resources/read', {
      uri: 'https://optionsahoy.com/learn/amt-crossover',
    });
    const contents = (res.result as { contents: Array<{ uri: string; text: string }> }).contents;
    expect(contents).toHaveLength(1);
    expect(contents[0].text).toContain('AMT');
  });

  it('lists all eight prompts', async () => {
    const res = await session.request('prompts/list');
    const prompts = (res.result as { prompts: Array<{ name: string }> }).prompts;
    expect(prompts.map((p) => p.name).sort()).toEqual([
      'analyze-concentration',
      'analyze-nso-decision',
      'analyze-rsu-vest',
      'check-qsbs-eligibility',
      'optimize-iso-exercise',
      'plan-equity-funding',
      'plan-equity-portfolio',
      'price-protective-put',
    ]);
  });

  it('returns a templated prompt body', async () => {
    const res = await session.request('prompts/get', {
      name: 'check-qsbs-eligibility',
      arguments: {
        acquisitionDate: '2020-01-15',
        saleDate: '2026-06-01',
        expectedGain: '5000000',
      },
    });
    const messages = (res.result as { messages: Array<{ role: string; content: { type: string; text: string } }> })
      .messages;
    expect(messages[0].role).toBe('user');
    expect(messages[0].content.type).toBe('text');
    expect(messages[0].content.text).toContain('2020-01-15');
    expect(messages[0].content.text).toContain('2026-06-01');
  });

  it.each([
    {
      tool: 'qsbs_check',
      args: {
        acquisitionDate: '2020-01-15',
        saleDate: '2026-06-01',
        entityType: 'us-c-corp',
        acquisitionMethod: 'original-issuance',
        assetCategory: 'under-50m',
        industry: 'tech-software',
        activeBusiness: 'yes',
        adjustedBasis: 100000,
        expectedGain: 5000000,
        stateCode: 'CA',
        ordinaryIncome: 250000,
        filingStatus: 'single',
      },
      check: (r: Record<string, unknown>) => {
        expect(r.verdict).toBe('qualifies');
        expect(r.exclusionPercent).toBe(1);
      },
    },
    {
      tool: 'protective_put_price',
      args: {
        positionValue: 400000,
        sector: 'tech_software',
        protectionLevel: 0.3,
        tenorYears: 1,
      },
      check: (r: Record<string, unknown>) => {
        expect(r.barePut).toBeDefined();
        expect(typeof (r.barePut as { annualCostPct: number }).annualCostPct).toBe('number');
      },
    },
    {
      tool: 'rsu_sell_vs_hold',
      args: {
        shares: 1000,
        currentPrice: 100,
        ordinaryIncome: 200000,
        filingStatus: 'single',
        stateCode: 'CA',
        stillEmployed: true,
        holdYears: 2,
        volatility: 0.3,
        ticker: 'MSFT',
      },
      check: (r: Record<string, unknown>) => {
        expect(r.vest).toBeDefined();
        expect(r.hold).toBeDefined();
        expect(r.sellNowInvest).toBeDefined();
      },
    },
    {
      tool: 'nso_calculate',
      args: {
        shares: 5000,
        strike: 10,
        currentPrice: 50,
        ordinaryIncome: 180000,
        filingStatus: 'single',
        stateCode: 'CA',
        stillEmployed: true,
        holdYears: 2,
        volatility: 0.3,
        holdFunding: 'cash',
        ticker: 'AAPL',
      },
      check: (r: Record<string, unknown>) => {
        expect(r.exercise).toBeDefined();
        expect(r.hold).toBeDefined();
        expect(r.sellNowInvest).toBeDefined();
      },
    },
    {
      tool: 'concentration_analyze',
      args: {
        positionValue: 400000,
        costBasis: 100000,
        acquisitionDate: '2022-01-01',
        sector: 'tech_software',
        stateCode: 'CA',
        filingStatus: 'single',
        ordinaryIncome: 200000,
        totalAssets: 1200000,
        volatility: 0.3,
        ticker: 'NVDA',
      },
      check: (r: Record<string, unknown>) => {
        expect(typeof r.concentration).toBe('number');
        expect(r.riskBand).toBeDefined();
      },
    },
    {
      tool: 'amt_iso_optimize',
      args: {
        shares: 10000,
        strike: 5,
        fmv: 40,
        volatility: 0.3,
        filingStatus: 'single',
        ordinaryIncome: 200000,
        stateCode: 'CA',
        carryforwardCredit: 0,
        horizon: 3,
        cashReturnRate: 0.05,
        grantDate: '2022-01-01',
        hasLeftCompany: false,
        terminationDate: null,
        ticker: 'NVDA',
      },
      check: (r: Record<string, unknown>) => {
        const schedules = r.schedules as Record<string, unknown>;
        expect(schedules.lumpSum).toBeDefined();
        expect(schedules.evenSplit).toBeDefined();
        expect(schedules.optimized).toBeDefined();
        expect(typeof r.crossoverShares).toBe('number');
      },
    },
    {
      tool: 'equity_funding_plan',
      args: {
        targetAfterTax: 400000,
        targetDate: '2027-08-01',
        lots: [
          { shares: 8000, costBasisPerShare: 25, acquisitionDate: '2023-06-15' },
        ],
        currentPrice: 110,
        // Growth is required-or-resolved as of 1.10.0 (no silent flat default);
        // "market" exercises the S&P-trailing sentinel end-to-end over stdio.
        expectedAnnualGrowth: 'market',
        ordinaryIncome: 200000,
        filingStatus: 'single',
        stateCode: 'CA',
      },
      check: (r: Record<string, unknown>) => {
        expect(r.recommended).toBeDefined();
        expect(r.lockInNow).toBeDefined();
        expect(r.balanced).toBeDefined();
        expect(r.holdForGrowth).toBeDefined();
        expect(Array.isArray(r.frontier)).toBe(true);
        const recommended = r.recommended as Record<string, unknown>;
        expect(typeof recommended.wealthAtTarget).toBe('number');
        expect(typeof recommended.shortfallProbability).toBe('number');
      },
    },
  ])('calls $tool successfully', async ({ tool, args, check }) => {
    const res = await session.request('tools/call', { name: tool, arguments: args });
    const result = res.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    check(parsed);
    // structuredContent mirrors the text block exactly (same result object,
    // serialized once into text and once as structured JSON).
    expect(result.structuredContent).toEqual(parsed);
  });


  describe('next-steps block (npx/MCPB installs)', () => {
    // The local server has no D1 and no session, so it gets the same bare
    // form sessionless hosted callers get: free tool + related tools, never
    // the once-per-session beta pitch. Before this, npx users were the one
    // tool surface with no route back to the web tools at all.
    it('a successful call carries the bare block and no beta pitch', async () => {
      const res = await session.request('tools/call', {
        name: 'qsbs_check',
        arguments: {
          acquisitionDate: '2020-03-01',
          saleDate: '2026-03-15',
          entityType: 'us-c-corp',
          acquisitionMethod: 'original-issuance',
          assetCategory: 'under-50m',
          industry: 'tech-software',
          activeBusiness: 'yes',
          adjustedBasis: 50000,
          expectedGain: 5000000,
          stateCode: 'CA',
          ordinaryIncome: 300000,
          filingStatus: 'single',
        },
      });
      const result = res.result as { content: Array<{ text: string }>; structuredContent?: unknown };
      const parsed = JSON.parse(result.content[0].text) as {
        next_steps?: { free_tool?: string; also_run?: string; beta?: string };
      };
      const next = parsed.next_steps;
      expect(next?.free_tool).toContain('optionsahoy.com/tools/qsbs?src=mcp_qsbs');
      expect(next?.also_run).toContain('OptionsAhoy tools to run next');
      expect(next?.beta).toBeUndefined();
      expect(next?.free_tool).not.toContain('&s=');
      // The mirror invariant must survive the injection.
      expect(result.structuredContent).toEqual(parsed);
    });

    it('an errored call carries no block', async () => {
      const res = await session.request('tools/call', { name: 'qsbs_check', arguments: {} });
      const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('optionsahoy.com/tools');
    });
  });

  it('returns isError for an unknown tool', async () => {
    const res = await session.request('tools/call', { name: 'no_such_tool', arguments: {} });
    const result = res.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown tool');
    expect(result.structuredContent).toBeUndefined();
  });

  it('answers ping with an empty success result (no -32601)', async () => {
    const res = await session.request('ping');
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});
  });

  it('answers resources/templates/list with an empty array (no -32601)', async () => {
    const res = await session.request('resources/templates/list');
    expect(res.error).toBeUndefined();
    const r = res.result as { resourceTemplates: unknown[] };
    expect(Array.isArray(r.resourceTemplates)).toBe(true);
    expect(r.resourceTemplates).toHaveLength(0);
  });

  it('rejects a prompt missing required arguments with a clean error', async () => {
    // analyze-rsu-vest has multiple required arguments — call with none of
    // them and expect the missing-args error to fire cleanly.
    const res = await session.request('prompts/get', {
      name: 'analyze-rsu-vest',
      arguments: {},
    });
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain('missing required arguments');
  });
});

