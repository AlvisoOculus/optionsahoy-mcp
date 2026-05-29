// AlphaLatitude Inc. © 2026
//
// Local stdio MCP server. Same six tools as the hosted endpoint at
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
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from '../functions/_lib/mcp-tools';
import { RESOURCES } from '../functions/_lib/mcp-resources';
import { PROMPTS } from '../functions/_lib/mcp-prompts';

const SERVER_INFO = { name: 'optionsahoy', version: '1.2.0' };

const server = new Server(SERVER_INFO, {
  capabilities: {
    tools: {},
    resources: {},
    prompts: {},
  },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
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

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
  })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const resource = RESOURCES.find((r) => r.uri === req.params.uri);
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

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS.map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments,
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const prompt = PROMPTS.find((p) => p.name === req.params.name);
  if (!prompt) throw new Error(`unknown prompt: ${req.params.name}`);
  const args = (req.params.arguments ?? {}) as Record<string, string>;
  return {
    description: prompt.description,
    messages: prompt.build(args),
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
