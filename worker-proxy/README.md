# optionsahoy-mcp-proxy

Tiny Cloudflare Worker that forwards `optionsahoy.com/mcp*` and
`optionsahoy.com/api/v1/*` to the optionsahoy-mcp Pages deployment origin.

## Why

The `optionsahoy.com` apex is owned by a separate Cloudflare Pages
project (the marketing site). Workers Routes take precedence over Pages
on the same domain, so this Worker intercepts only the MCP + REST paths
and leaves the rest of optionsahoy.com untouched. This preserves the
public URLs we've already published to every MCP registry.

## One-time deploy

```bash
cd worker-proxy
npm install
npx wrangler login          # browser OAuth, ~30s
npx wrangler deploy         # publishes Worker + attaches routes
```

That's it. Subsequent deploys are the same `npx wrangler deploy` command,
or wire up the optional GH Actions workflow at
`.github/workflows/deploy-proxy.yml` (requires `CF_API_TOKEN` repo secret).

## Verify

```bash
curl https://optionsahoy.com/mcp \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
```

Should return MCP server info from the Pages deployment origin.
