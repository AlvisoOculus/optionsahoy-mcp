// AlphaLatitude Inc. © 2026
// Single source of truth for the version reported in MCP serverInfo.
// Registries (Smithery, Glama) display this from initialize responses;
// hardcoded copies drifted (hosted said 1.2.0 while npm was at 1.9.1).
import pkg from '../../package.json';

export const SERVER_VERSION: string = pkg.version;
