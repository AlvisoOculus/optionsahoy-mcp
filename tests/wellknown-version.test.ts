// AlphaLatitude Inc. © 2026
//
// The discovery files under public/.well-known/ each advertise a `version`.
// They are hand-maintained JSON, so they drift: on 2026-08-10 the server
// reported 1.10.1 through initialize while mcp.json still said 1.0.0 and both
// agent cards said 0.1.0 - versions from before the tool suite existed.
//
// That is not cosmetic. These files are what a registry, a crawler or an
// agent reads to decide whether it already knows this server, so a frozen
// version says "nothing has changed here" through every release.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { LATEST_PROTOCOL_VERSION } from '../functions/_lib/version';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const VERSIONED = [
  'public/.well-known/mcp.json',
  'public/.well-known/agent-card.json',
  'public/.well-known/agent.json',
  // The copy served at optionsahoy.com/.well-known/mcp.json - the one agents
  // actually read. It lives in the web repo, which releases separately, and
  // had no guard at all: it sat at 1.9.8 while this repo reported 1.10.1.
  // Skipped when the sibling checkout is absent (CI clones one repo).
  '../optionsahoy_web/web/public/.well-known/mcp.json',
];

describe('.well-known discovery files track the package version', () => {
  it.each(VERSIONED)('%s matches package.json', (file) => {
    if (!existsSync(file)) return; // sibling repo not checked out
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
    expect(doc.version, `${file} is stale - run npm run gen:wellknown`).toBe(pkg.version);
  });

  it('is the same version initialize reports, so discovery and handshake agree', async () => {
    const { onRequest } = await import('../functions/mcp');
    const res = await onRequest({
      request: new Request('https://optionsahoy.com/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      }),
      env: {},
    } as never);
    const body = (await (res as Response).json()) as { result: { serverInfo: { version: string } } };
    expect(body.result.serverInfo.version).toBe(pkg.version);
  });
});

// The MCP discovery files also advertise a protocol version. It sat at
// 2024-11-05 through 2026-11 because initialize answered nothing else; now that
// initialize negotiates, they advertise the newest version it speaks. (The
// agent cards' protocolVersion is A2A's, a different protocol, so not here.)
const MCP_DISCOVERY = VERSIONED.filter((f) => f.endsWith('/mcp.json'));

describe('MCP discovery files advertise the newest protocol version /mcp speaks', () => {
  it.each(MCP_DISCOVERY)('%s says the newest protocol version', (file) => {
    if (!existsSync(file)) return; // sibling repo not checked out
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { protocolVersion?: string };
    expect(doc.protocolVersion, `${file} is stale - run npm run gen:wellknown`).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('is the version GET /mcp advertises', async () => {
    const { onRequest } = await import('../functions/mcp');
    const res = await onRequest({ request: new Request('https://optionsahoy.com/mcp'), env: {} } as never);
    const body = (await (res as Response).json()) as { protocolVersion: string };
    expect(body.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });
});
