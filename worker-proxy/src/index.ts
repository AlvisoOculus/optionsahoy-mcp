// AlphaLatitude Inc. © 2026
//
// Proxy Worker: forwards optionsahoy.com/mcp* and /api/v1/* requests
// to optionsahoy-mcp.pages.dev (configured in wrangler.toml vars).
// Preserves method, headers, body, and query string verbatim.
//
// Why a proxy and not "deploy MCP server as a Worker": the existing
// code is Cloudflare Pages Functions style (one onRequest export per
// file, file-based routing). Pages handles all 7 routes for free.
// Rewriting to a single-Worker router is unnecessary churn when this
// 15-line proxy gets the URL stability we want.

export interface Env {
  UPSTREAM_HOST: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    url.hostname = env.UPSTREAM_HOST;
    const fwd = new Request(url.toString(), request);
    // The upstream Pages function's request.cf describes THIS worker's
    // egress (always Cloudflare/Dallas), not the caller — which blinded
    // the stats to every real client's network. Forward the caller's
    // coarse geo + AS metadata (never the IP; stats stores no PII) so
    // the upstream can attribute traffic to real networks.
    const cf = (request as { cf?: Record<string, unknown> }).cf ?? {};
    const set = (name: string, v: unknown) => {
      if (v !== undefined && v !== null && v !== '') fwd.headers.set(name, String(v));
    };
    set('x-oa-client-country', cf.country);
    set('x-oa-client-region', cf.region);
    set('x-oa-client-city', cf.city);
    set('x-oa-client-as-org', cf.asOrganization);
    set('x-oa-client-asn', cf.asn);
    // Tail-able marker for live debugging (`wrangler tail --search OA_MCP_CLIENT`).
    // Logs are ephemeral (visible only while tailing); no IP is logged.
    if (url.pathname.startsWith('/mcp') && request.method === 'POST') {
      console.log('OA_MCP_CLIENT ' + JSON.stringify({
        ua: request.headers.get('user-agent'),
        asOrg: cf.asOrganization ?? null,
        asn: cf.asn ?? null,
        country: cf.country ?? null,
        city: cf.city ?? null,
      }));
    }
    return fetch(fwd);
  },
};
