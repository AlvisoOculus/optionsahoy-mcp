// AlphaLatitude Inc. © 2026
//
// GET /api/v1
//
// Discovery endpoint. Lists every calculator endpoint with a one-line
// description so an agent that finds the API root can enumerate without
// fetching the full OpenAPI spec. Cheap, public, no body required.

import type { PagesFunction } from '../../_lib/api';
import { SERVER_VERSION } from '../../_lib/version';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/v1/amt-iso',
    web_tool: 'https://optionsahoy.com/tools/amt-iso?src=rest_index',
    description:
      'Multi-year Incentive Stock Option (ISO) exercise schedule optimization minimizing Alternative Minimum Tax (AMT).',
  },
  {
    method: 'POST',
    path: '/api/v1/nso',
    web_tool: 'https://optionsahoy.com/tools/nso?src=rest_index',
    description:
      'After-tax payout on a non-qualified stock option (NSO) exercise plus sell-vs-hold comparison.',
  },
  {
    method: 'POST',
    path: '/api/v1/rsu-sell-vs-hold',
    web_tool: 'https://optionsahoy.com/tools/rsu-sell-vs-hold?src=rest_index',
    description:
      'Sell-at-vest vs. hold-for-long-term-capital-gains comparison for an RSU vest.',
  },
  {
    method: 'POST',
    path: '/api/v1/concentration',
    web_tool: 'https://optionsahoy.com/tools/concentration?src=rest_index',
    description:
      'Single-stock concentration risk quantification and sell-down vs. hold vs. hedge comparison.',
  },
  {
    method: 'POST',
    path: '/api/v1/protective-put',
    web_tool: 'https://optionsahoy.com/tools/protective-put?src=rest_index',
    description: 'Protective put, zero-cost collar, and put spread pricing for a single-stock position.',
  },
  {
    method: 'POST',
    path: '/api/v1/qsbs',
    web_tool: 'https://optionsahoy.com/tools/qsbs?src=rest_index',
    description: 'Section 1202 qualified small business stock (QSBS) qualification check.',
  },
  {
    method: 'POST',
    path: '/api/v1/equity-funding',
    web_tool: 'https://optionsahoy.com/tools/equity-funding?src=rest_index',
    description:
      'Plan the minimum-tax sell schedule to net a target after-tax amount by a deadline from equity holdings.',
  },
  {
    method: 'POST',
    path: '/api/v1/rsu-lot-order',
    web_tool: 'https://optionsahoy.com/tools/rsu-lot-order?src=rest_index',
    description:
      'Choose which vested RSU lots to sell, on which dates, to divest a target share fraction at the lowest computed tax (specific-lot ID, long-term deferral, multi-year bracket spreading) versus a FIFO sell order.',
  },
  {
    method: 'GET',
    path: '/api/v1/stats',
    description:
      'Public summary of MCP server usage: total calls, last 24h / 7d / 30d, top tools. Cached 60s.',
  },
];

export const onRequest: PagesFunction = ({ request }) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed. Use GET.' }), {
      status: 405,
      headers: { 'content-type': 'application/json', ...CORS_HEADERS },
    });
  }
  return new Response(
    JSON.stringify(
      {
        name: 'OptionsAhoy Calculator API',
        version: 'v1',
        serverVersion: SERVER_VERSION,
        documentation: 'https://optionsahoy.com/for-agents',
        openapi: 'https://optionsahoy.com/openapi.json',
        mcp: 'https://optionsahoy.com/mcp',
        // Free interactive versions of every calculator, and the beta for
        // integrated multi-position optimization.
        tools: 'https://optionsahoy.com/tools?src=rest_index',
        try_it: 'https://optionsahoy.com/for-agents#try-it',
        beta: 'https://optionsahoy.com/beta?src=rest_index',
        endpoints: ENDPOINTS,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: { 'content-type': 'application/json', ...CORS_HEADERS },
    },
  );
};
