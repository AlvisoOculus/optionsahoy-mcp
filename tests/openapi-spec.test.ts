// AlphaLatitude Inc. © 2026
//
// Validates the static OpenAPI spec at web/public/openapi.json:
//   - parses as JSON
//   - claims OpenAPI 3.1.x
//   - documents exactly the endpoints we ship in functions/api/v1
//   - lists every component schema referenced from path operations
//
// Catches the case where someone adds or renames an endpoint but forgets
// to update the spec, or references a schema that doesn't exist.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SPEC_PATH = path.resolve(__dirname, '../public/openapi.json');
const FUNCTIONS_DIR = path.resolve(__dirname, '../functions/api/v1');

type Spec = {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
};

function loadSpec(): Spec {
  return JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as Spec;
}

function listShippedEndpoints(): string[] {
  // Each .ts file in functions/api/v1/ that isn't an index/lib becomes an
  // endpoint at /api/v1/<basename>. The index.ts becomes /api/v1.
  return fs
    .readdirSync(FUNCTIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => {
      const base = f.slice(0, -3);
      return base === 'index' ? '/api/v1' : `/api/v1/${base}`;
    })
    .sort();
}

describe('OpenAPI spec at /openapi.json', () => {
  it('parses as valid JSON', () => {
    expect(() => loadSpec()).not.toThrow();
  });

  it('declares OpenAPI 3.1.x', () => {
    const spec = loadSpec();
    expect(spec.openapi).toMatch(/^3\.1\./);
  });

  it('has info.title, info.version, and a production server', () => {
    const spec = loadSpec();
    expect(spec.info.title).toMatch(/OptionsAhoy/);
    expect(spec.info.version).toBeTypeOf('string');
    expect(spec.servers.some((s) => s.url === 'https://optionsahoy.com')).toBe(true);
  });

  it('documents every shipped endpoint and nothing more', () => {
    const spec = loadSpec();
    const documented = Object.keys(spec.paths).sort();
    expect(documented).toEqual(listShippedEndpoints());
  });

  it('every $ref points at an existing component', () => {
    const spec = loadSpec();
    const json = JSON.stringify(spec);
    const refs = Array.from(json.matchAll(/"\$ref":"([^"]+)"/g)).map((m) => m[1]!);
    for (const ref of refs) {
      const m = ref.match(/^#\/components\/(schemas|responses)\/(.+)$/);
      expect(m, `unexpected $ref shape: ${ref}`).not.toBeNull();
      const [, group, name] = m!;
      const bucket = (spec.components as unknown as Record<string, Record<string, unknown>>)[
        group!
      ];
      expect(bucket?.[name!], `missing component: ${ref}`).toBeDefined();
    }
  });

  it('every POST endpoint requires a requestBody and documents 200/400/405', () => {
    const spec = loadSpec();
    for (const [route, methods] of Object.entries(spec.paths)) {
      const post = methods.post as
        | { requestBody?: { required?: boolean }; responses?: Record<string, unknown> }
        | undefined;
      if (!post) continue;
      expect(post.requestBody?.required, `${route} POST missing required body`).toBe(true);
      expect(post.responses?.['200'], `${route} POST missing 200 response`).toBeDefined();
      expect(post.responses?.['400'], `${route} POST missing 400 response`).toBeDefined();
      expect(post.responses?.['405'], `${route} POST missing 405 response`).toBeDefined();
    }
  });
});
