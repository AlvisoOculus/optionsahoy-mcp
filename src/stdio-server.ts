// AlphaLatitude Inc. © 2026
//
// Local stdio MCP server. Same tools as the hosted endpoint at
// https://optionsahoy.com/mcp, exposed over the Model Context Protocol
// stdio transport so MCP clients that only support local stdio servers
// (Claude Desktop without mcp-remote, Glama installer, etc.) can use
// them.
//
// Source of truth for tool definitions + handlers is functions/_lib/
// mcp-tools.ts. This file is a thin adapter that wires those handlers
// to the SDK's stdio transport. The hosted HTTP endpoint at
// functions/mcp.ts and this stdio server return byte-identical
// responses for the same input.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from '../functions/_lib/mcp-tools';
import { RESOURCES } from '../functions/_lib/mcp-resources';
import { PROMPTS } from '../functions/_lib/mcp-prompts';

const SERVER_INFO = { name: 'optionsahoy', version: '1.5.0' };

// Precomputed list projections + name lookups, mirroring the precomputation
// in functions/mcp.ts so list calls don't allocate on every request and
// lookups are O(1).
const TOOLS_LIST = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: t.annotations,
}));
const RESOURCES_LIST = RESOURCES.map((r) => ({
  uri: r.uri,
  name: r.name,
  description: r.description,
  mimeType: r.mimeType,
}));
const PROMPTS_LIST = PROMPTS.map((p) => ({
  name: p.name,
  description: p.description,
  arguments: p.arguments,
}));
const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const RESOURCES_BY_URI = new Map(RESOURCES.map((r) => [r.uri, r]));
const PROMPTS_BY_NAME = new Map(PROMPTS.map((p) => [p.name, p]));

const server = new Server(SERVER_INFO, {
  capabilities: {
    tools: {},
    resources: {},
    prompts: {},
  },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS_BY_NAME.get(req.params.name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Error: unknown tool "${req.params.name}"` }],
      isError: true,
    };
  }
  try {
    const result = tool.handler(req.params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES_LIST }));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const resource = RESOURCES_BY_URI.get(req.params.uri);
  if (!resource) throw new Error(`unknown resource: ${req.params.uri}`);
  return {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: resource.contents,
      },
    ],
  };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS_LIST }));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const prompt = PROMPTS_BY_NAME.get(req.params.name);
  if (!prompt) throw new Error(`unknown prompt: ${req.params.name}`);
  const args = (req.params.arguments ?? {}) as Record<string, string>;
  // Mirror functions/mcp.ts:175-181: surface a clean error if a required
  // argument is missing rather than crashing inside prompt.build().
  const missing = prompt.arguments
    .filter((a) => a.required && !args[a.name])
    .map((a) => a.name);
  if (missing.length > 0) {
    throw new Error(`prompt "${prompt.name}" missing required arguments: ${missing.join(', ')}`);
  }
  return {
    description: prompt.description,
    messages: prompt.build(args),
  };
});

// Health-check and discovery methods that clients (including Glama's Try
// in Browser introspection) probe even though they're not always
// advertised in the initialize response. Return success so the client gets
// a -32601 only for methods we genuinely do not implement.

server.setRequestHandler(PingRequestSchema, async () => ({}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
