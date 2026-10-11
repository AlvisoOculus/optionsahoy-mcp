// AlphaLatitude Inc. © 2026
//
// What the public call count is made of. /api/v1/stats, the /for-agents
// banner, the README badge and /mcp/usage count every request the server
// logs. This splits the same requests by caller and by type, so the admin
// funnel can say what the number is and where it comes from. Rows come from
// the reqclient rollup (adminRollup.ts). Callers are classified with the
// shared classifier, so the funnel never re-implements it.
//
// Why: on 2026-10-10 the counter read about 15k requests a day, and 86% of
// them were one client's keep-alive pings, handshakes and session closes
// (copilot-cli, which called no tool). Only a few hundred asked for a
// calculation. Nothing on the admin pages could show that.

import { classifyClient, surfaceOf, type ClientKind } from './classify';

export interface ReqClientRow {
  endpoint: string;
  client: string;
  n: number;
  errors: number;
}

// Requests that ask for work: a calculation over MCP or REST, or an A2A
// message. The same set the callclient rollup keeps. Everything else is
// protocol housekeeping (handshakes, keep-alives, list reads) or a probe.
export function isWorkEndpoint(endpoint: string): boolean {
  return endpoint === 'mcp:tools/call' || endpoint.startsWith('rest:') || endpoint === 'a2a';
}

const WHAT: Record<string, string> = {
  'mcp:ping': 'Keep-alive from a connected client. Does no work.',
  'mcp:initialize': 'Connection handshake, one per session.',
  'mcp:tools/list': 'A client reading the list of tools.',
  'mcp:tools/call': 'A calculation.',
  'mcp:session-delete': 'A client ending its session on shutdown.',
  'mcp:server/discover': 'A discovery method we do not serve. Answered method-not-found, so logged as an error.',
  'mcp:prompts/list': 'A client reading the list of prompts.',
  'mcp:prompts/get': 'A client fetching one prompt.',
  'mcp:resources/list': 'A client reading the list of resources.',
  'mcp:resources/templates/list': 'A client reading the list of resource templates.',
  'mcp:resources/read': 'A client reading one resource.',
  'mcp:GET': 'A plain GET on /mcp: a browser, or a client checking what lives here.',
  'mcp:HEAD': 'A HEAD on /mcp: health checkers and uptime monitors.',
  a2a: 'An A2A message: a calculation request from another agent.',
  'a2a:tasks/get': 'An A2A task-status poll. Every call finishes at once, so there is never a task to find.',
  'a2a:card': 'An A2A agent-card fetch.',
  'poe:query': 'A message to the Poe bot.',
};

export function describeEndpoint(endpoint: string): string {
  const known = WHAT[endpoint];
  if (known) return known;
  if (endpoint.startsWith('rest:')) return 'A calculation through the REST API.';
  if (endpoint.startsWith('poe:')) return 'A Poe bot request.';
  if (endpoint.startsWith('a2a:')) return 'An A2A method we do not serve.';
  return 'A method we do not serve, or a malformed request.';
}

export const KIND_LABEL: Record<ClientKind, string> = {
  human: 'AI assistants and IDEs (a person in the loop)',
  agent: 'Agent frameworks and SDKs',
  unknown: 'Unclassified',
  tool: 'Scripts and bare HTTP clients',
  smoke: 'Our own monitors and tests',
  crawler: 'Directories, crawlers and scanners',
};

export interface CallerTraffic {
  client: string;
  kind: ClientKind;
  label: string;
  n: number;
  work: number;
  workOk: number;
  top: { endpoint: string; n: number }[];
}

export interface TrafficBreakdown {
  total: number;
  callers: number;
  work: number;
  workOk: number;
  byKind: { kind: ClientKind; label: string; callers: number; n: number; work: number; workOk: number }[];
  byCaller: CallerTraffic[];
  otherCallers: { callers: number; n: number; work: number; workOk: number };
  byEndpoint: { endpoint: string; what: string; n: number; errors: number }[];
}

type CallerAcc = Omit<CallerTraffic, 'top'> & { eps: Map<string, number> };

const tally = (xs: CallerAcc[]) => ({
  callers: xs.length,
  n: xs.reduce((a, x) => a + x.n, 0),
  work: xs.reduce((a, x) => a + x.work, 0),
  workOk: xs.reduce((a, x) => a + x.workOk, 0),
});

export function trafficBreakdown(rows: ReqClientRow[], topCallers = 15): TrafficBreakdown {
  const callers = new Map<string, CallerAcc>();
  const endpoints = new Map<string, TrafficBreakdown['byEndpoint'][number]>();
  for (const r of rows) {
    const e = endpoints.get(r.endpoint) ?? { endpoint: r.endpoint, what: describeEndpoint(r.endpoint), n: 0, errors: 0 };
    e.n += r.n;
    e.errors += r.errors;
    endpoints.set(r.endpoint, e);

    let c = callers.get(r.client);
    if (!c) {
      const { kind, label } = classifyClient(r.client, surfaceOf(r.endpoint));
      c = { client: r.client, kind, label, n: 0, work: 0, workOk: 0, eps: new Map() };
      callers.set(r.client, c);
    }
    c.n += r.n;
    c.eps.set(r.endpoint, (c.eps.get(r.endpoint) ?? 0) + r.n);
    if (isWorkEndpoint(r.endpoint)) {
      c.work += r.n;
      c.workOk += r.n - r.errors;
    }
  }

  const ranked = [...callers.values()].sort((a, b) => b.n - a.n);
  const all = tally(ranked);
  const kinds = [...new Set(ranked.map((c) => c.kind))].map((kind) => ({
    kind,
    label: KIND_LABEL[kind],
    ...tally(ranked.filter((c) => c.kind === kind)),
  }));
  return {
    total: all.n,
    callers: all.callers,
    work: all.work,
    workOk: all.workOk,
    byKind: kinds.sort((a, b) => b.n - a.n),
    byCaller: ranked.slice(0, topCallers).map(({ eps, ...c }) => ({
      ...c,
      top: [...eps].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([endpoint, n]) => ({ endpoint, n })),
    })),
    otherCallers: tally(ranked.slice(topCallers)),
    byEndpoint: [...endpoints.values()].sort((a, b) => b.n - a.n),
  };
}
