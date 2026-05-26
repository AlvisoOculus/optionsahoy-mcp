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
    // Cloudflare Worker fetch automatically follows redirects + handles
    // the body as a stream. Forwarding the original Request preserves
    // method, headers, body. Strip any CF-injected headers if needed,
    // but for this read-only proxy the defaults are fine.
    const upstream = new Request(url.toString(), request);
    return fetch(upstream);
  },
};
