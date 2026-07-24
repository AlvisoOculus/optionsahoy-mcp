// AlphaLatitude Inc. © 2026
//
// Conformance guard: every tool's zod request schema must expose exactly the
// property set that public/openapi.json declares for the same REST endpoint.
// openapi.json is the source of truth all adapters mirror; this test fails CI
// when a field is added or dropped on one surface but not the other (the exact
// drift class that let `haircut`, `ticker`, and `today` diverge historically).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  amtIsoParameters,
  concentrationParameters,
  equityFundingParameters,
  nsoParameters,
  protectivePutParameters,
  qsbsParameters,
  rsuLotParameters,
  rsuParameters,
} from '../src/schemas';

// REST slug -> the zod schema the adapter POSTs to that endpoint.
const SCHEMA_BY_SLUG: Record<string, z.ZodObject<z.ZodRawShape>> = {
  'amt-iso': amtIsoParameters,
  nso: nsoParameters,
  'rsu-sell-vs-hold': rsuParameters,
  concentration: concentrationParameters,
  'protective-put': protectivePutParameters,
  qsbs: qsbsParameters,
  'equity-funding': equityFundingParameters,
  'rsu-lot-order': rsuLotParameters,
};

interface OpenApiSchema {
  properties?: Record<string, unknown>;
  $ref?: string;
}
interface OpenApiDoc {
  paths: Record<
    string,
    { post?: { requestBody?: { content?: { 'application/json'?: { schema?: OpenApiSchema } } } } }
  >;
  components?: { schemas?: Record<string, OpenApiSchema> };
}

// Load and index openapi.json by REST slug -> sorted request-property names.
function openApiPropsBySlug(): Record<string, string[]> {
  const openApiPath = fileURLToPath(new URL('../../../../public/openapi.json', import.meta.url));
  const doc = JSON.parse(readFileSync(openApiPath, 'utf8')) as OpenApiDoc;
  const out: Record<string, string[]> = {};
  for (const [path, ops] of Object.entries(doc.paths)) {
    const schema = ops.post?.requestBody?.content?.['application/json']?.schema;
    if (!schema) continue;
    const resolved = schema.$ref
      ? doc.components?.schemas?.[schema.$ref.split('/').pop() as string]
      : schema;
    const slug = path.split('/').pop() as string;
    out[slug] = Object.keys(resolved?.properties ?? {}).sort();
  }
  return out;
}

describe('adapter schemas conform to openapi.json request bodies', () => {
  const bySlug = openApiPropsBySlug();

  it('covers every REST slug the adapter targets', () => {
    for (const slug of Object.keys(SCHEMA_BY_SLUG)) {
      expect(bySlug[slug], `openapi.json missing /api/v1/${slug}`).toBeDefined();
    }
  });

  for (const [slug, schema] of Object.entries(SCHEMA_BY_SLUG)) {
    it(`${slug}: zod properties match openapi`, () => {
      const zodKeys = Object.keys(schema.shape).sort();
      expect(zodKeys).toEqual(bySlug[slug]);
    });
  }
});
