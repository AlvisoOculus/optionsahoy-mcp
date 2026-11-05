// AlphaLatitude Inc. © 2026
// Single source of truth for the version reported in MCP serverInfo.
// Registries (Smithery, Glama) display this from initialize responses;
// hardcoded copies drifted (hosted said 1.2.0 while npm was at 1.9.1).
import pkg from '../../package.json';

export const SERVER_VERSION: string = pkg.version;

// The MCP protocol revisions /mcp speaks, newest first. initialize echoes the
// client's version when it is one of these and otherwise answers the newest
// (functions/mcp.ts); until 2026-11 it answered 2024-11-05 to every client.
// The discovery files advertise the newest (npm run gen:wellknown stamps it).
//
// The list is the MCP SDK's, which the stdio server negotiates from, so both
// servers answer a well-formed initialize alike (the SDK rejects a missing or
// non-string version, where /mcp answers the newest). It is copied, not
// imported: the SDK's types module loads zod, about 92 KB more in the Pages
// bundle, and an import would adopt the SDK's next revision unreviewed.
// tests/mcp-server.test.ts fails when the copy and the SDK differ.
//
// 2026-07-28 is deliberately absent. It replaces initialize with metadata on
// every request, and its clients probe server/discover first, get -32601
// from /mcp, and fall back to initialize with a version from this list.
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07',
];
