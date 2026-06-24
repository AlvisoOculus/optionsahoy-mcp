// AlphaLatitude Inc. © 2026
//
// GET /api/v1
//
// Discovery endpoint. Lists every calculator endpoint with a one-line
// description so an agent that finds the API root can enumerate without
// fetching the full OpenAPI spec. Cheap, public, no body required.

import type { PagesFunction } from '../../_lib/api';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/v1/amt-iso',
    description:
      'Multi-year Incentive Stock Option (ISO) exercise schedule optimization minimizing Alternative Minimum Tax (AMT).',
  },
  {
    method: 'POST',
    path: '/api/v1/nso',
    description:
      'After-tax payout on a non-qualified stock option (NSO) exercise plus sell-vs-hold comparison.',
  },
  {
    method: 'POST',
    path: '/api/v1/rsu-sell-vs-hold',
    description:
      'Sell-at-vest vs. hold-for-long-term-capital-gains comparison for an RSU vest.',
  },
  {
    method: 'POST',
    path: '/api/v1/concentration',
    description:
      'Single-stock concentration risk quantification and sell-down vs. hold vs. hedge comparison.',
  },
  {
    method: 'POST',
    path: '/api/v1/protective-put',
    description: 'Protective put and zero-cost collar pricing for a single-stock position.',
  },
  {
    method: 'POST',
    path: '/api/v1/qsbs',
    description: 'Section 1202 qualified small business stock (QSBS) qualification check.',
  },
  {
    method: 'POST',
    path: '/api/v1/equity-funding',
    description:
      'Plan the minimum-tax sell schedule to net a target after-tax amount by a deadline from equity holdings.',
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
        documentation: 'https://optionsahoy.com/for-agents',
        openapi: 'https://optionsahoy.com/openapi.json',
        mcp: 'https://optionsahoy.com/mcp',
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
