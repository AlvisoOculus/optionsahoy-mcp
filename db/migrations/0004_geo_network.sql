-- AlphaLatitude Inc. © 2026
--
-- Add coarse geo + originating-network columns for bot detection. The raw IP
-- is deliberately NOT stored; we keep only what Cloudflare derives:
--   - as_org / asn: the originating network operator. A direct REST caller
--     from a hosting/datacenter network (AWS, GCP, OVH, Hetzner...) is almost
--     certainly automation; a real person comes from a consumer ISP. This is
--     the primary bot signal, and unlike the User-Agent it cannot be spoofed
--     for free. NOTE: it only discriminates on the REST/direct surface; MCP
--     calls from a real user originate from the assistant's cloud, so cloud
--     origin is expected there and is not a bot signal.
--   - region / city: coarse location. A fallback datacenter tell (bot traffic
--     geolocates to datacenter towns) when no company is present in the query.
--
-- Apply remotely:
--   npx wrangler d1 execute optionsahoy-mcp-stats --remote \
--     --file=db/migrations/0004_geo_network.sql

ALTER TABLE mcp_calls ADD COLUMN as_org TEXT;
ALTER TABLE mcp_calls ADD COLUMN asn INTEGER;
ALTER TABLE mcp_calls ADD COLUMN region TEXT;
ALTER TABLE mcp_calls ADD COLUMN city TEXT;

ALTER TABLE mcp_samples ADD COLUMN country TEXT;
ALTER TABLE mcp_samples ADD COLUMN region TEXT;
ALTER TABLE mcp_samples ADD COLUMN city TEXT;
ALTER TABLE mcp_samples ADD COLUMN as_org TEXT;
ALTER TABLE mcp_samples ADD COLUMN asn INTEGER;
