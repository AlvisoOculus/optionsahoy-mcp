// AlphaLatitude Inc. © 2026
//
// Drift guard for the README's "What a call looks like" section. Every figure
// quoted there is supposed to come from a real production response, so this
// binds each per-tool block to its committed capture under docs/examples/:
// a figure that appears in the README but nowhere in the raw response fails
// the tool's test by name. Editing a README number therefore requires
// re-running scripts/capture-readme-examples.mts, which is the point.
//
// The block for a tool runs from its `### \`tool_name\`` heading through the
// line carrying the ([raw](docs/examples/tool_name.json)) link, so the
// section's intro and closing notes (which discuss tax years, not results)
// are deliberately out of scope.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXAMPLE_ARGS } from '../scripts/capture-readme-examples.mjs';

const README = readFileSync('README.md', 'utf8');
const SECTION_HEADING = '## What a call looks like (all eight tools)';

function section(): string {
  const start = README.indexOf(SECTION_HEADING);
  expect(start, `README is missing "${SECTION_HEADING}"`).toBeGreaterThan(-1);
  const rest = README.slice(start + SECTION_HEADING.length);
  const end = rest.indexOf('\n## ');
  return rest.slice(0, end === -1 ? undefined : end);
}

function blockFor(tool: string): string {
  const body = section();
  const start = body.indexOf(`### \`${tool}\``);
  expect(start, `no worked example for ${tool}`).toBeGreaterThan(-1);
  const rest = body.slice(start);
  const link = rest.indexOf(`docs/examples/${tool}.json`);
  expect(link, `${tool} block does not link its raw capture`).toBeGreaterThan(-1);
  return rest.slice(0, link);
}

// A quoted figure: optional $, digits with thousands separators, optional
// decimals, optional % or K/M magnitude suffix. Captured as written so the
// decimal count can set the rounding tolerance.
const FIGURE = /\$?(\d[\d,]*(?:\.\d+)?)([%KM])?/g;

type Figure = { text: string; value: number; decimals: number; percent: boolean };

function figuresIn(block: string): Figure[] {
  const out: Figure[] = [];
  for (const m of block.matchAll(FIGURE)) {
    const digits = m[1].replace(/,/g, '');
    const suffix = m[2];
    let value = Number(digits);
    if (suffix === 'K') value *= 1_000;
    if (suffix === 'M') value *= 1_000_000;
    const dot = digits.indexOf('.');
    out.push({
      text: m[0],
      value,
      decimals: dot === -1 || suffix === 'K' || suffix === 'M' ? 0 : digits.length - dot - 1,
      percent: suffix === '%',
    });
  }
  return out;
}

// Every numeric literal anywhere in the capture, including inside strings
// (the engine phrases several answers as prose: "33%", "6.0 years held").
function poolFor(tool: string): number[] {
  const raw = readFileSync(`docs/examples/${tool}.json`, 'utf8');
  const nums: number[] = [];
  for (const m of raw.matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)) {
    const v = Number(m[0]);
    if (Number.isFinite(v)) { nums.push(v, Math.abs(v)); }
  }
  return nums;
}

function isQuoted(f: Figure, pool: number[]): boolean {
  const tol = 0.5 * 10 ** -f.decimals + 1e-9;
  const candidates = f.percent ? [f.value, f.value / 100] : [f.value];
  return pool.some((v) => candidates.some((c) => Math.abs(v - c) <= tol || Math.abs(v * 100 - c) <= tol));
}

const TOOLS = Object.keys(EXAMPLE_ARGS) as string[];

describe('README worked examples are real captured output', () => {
  it('covers all eight tools', () => {
    expect(TOOLS.length).toBe(8);
  });

  for (const tool of TOOLS) {
    describe(tool, () => {
      it('quotes only figures present in docs/examples/' + tool + '.json', () => {
        const pool = poolFor(tool);
        const missing = figuresIn(blockFor(tool)).filter((f) => !isQuoted(f, pool)).map((f) => f.text);
        expect(
          missing,
          `${tool}: README quotes ${missing.join(', ')}, which the captured response does not contain. ` +
          're-run: npx tsx scripts/capture-readme-examples.mts',
        ).toEqual([]);
      });

      it('capture was taken with the committed example arguments', () => {
        const capture = JSON.parse(readFileSync(`docs/examples/${tool}.json`, 'utf8'));
        expect(capture.request.params.arguments).toEqual((EXAMPLE_ARGS as Record<string, unknown>)[tool]);
      });

      it('capture is a successful tool result', () => {
        const capture = JSON.parse(readFileSync(`docs/examples/${tool}.json`, 'utf8'));
        expect(capture.response.isError).not.toBe(true);
        expect(capture.response.structuredContent).toBeTruthy();
      });
    });
  }
});
