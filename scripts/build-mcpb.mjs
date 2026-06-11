// AlphaLatitude Inc. © 2026
// Builds the Claude Desktop extension bundle (optionsahoy.mcpb).
// Run via `npm run build:mcpb`. Requires `npm run build` output in dist/.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

for (const path of ['mcpb/manifest.json', 'gemini-extension.json', 'server.json']) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`${path} version synced to ${pkg.version}`);
  }
}

mkdirSync('mcpb/server', { recursive: true });
copyFileSync('dist/stdio-server.js', 'mcpb/server/index.js');

execFileSync('npx', ['-y', '@anthropic-ai/mcpb@latest', 'pack', 'mcpb', 'optionsahoy.mcpb'], {
  stdio: 'inherit',
});
