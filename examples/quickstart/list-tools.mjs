// AlphaLatitude Inc. © 2026
//
// List every MCP tool exposed by https://optionsahoy.com/mcp.
// Hits the hosted endpoint over JSON-RPC; no SDK, no auth, no install.
//
//   node list-tools.mjs

const MCP_URL = 'https://optionsahoy.com/mcp';

const response = await fetch(MCP_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  }),
});

const json = await response.json();
const tools = json.result?.tools ?? [];

console.log(`\n${tools.length} tools available at ${MCP_URL}\n`);
for (const tool of tools) {
  console.log(`• ${tool.name}`);
  console.log(`  ${tool.description.slice(0, 140).replace(/\s+/g, ' ')}…`);
}
console.log();
