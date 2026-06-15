// AlphaLatitude Inc. © 2026
//
// Codegen: the main app's year-keyed taxTables.js is the single source of record
// for the federal tax constants (cross-checked against the IRS publications). The
// MCP server's tax engine must not keep a hand-edited second copy that can drift
// (the same duplication-bug class that bit the toolspec.json copies). This script
// reads taxTables.js and emits lib/tax/generated/federal-tax-tables.generated.ts.
//
//   node scripts/codegen/gen-federal-tax-tables.mjs          # write
//   node scripts/codegen/gen-federal-tax-tables.mjs --check  # CI: fail if stale
//
// Source path is the sibling main-app repo; override with TAXTABLES_SRC.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC =
  process.env.TAXTABLES_SRC ||
  path.resolve(here, '../../../optionsahoy/backend/src/calculations/taxTables.js');
const OUT = path.resolve(here, '../../lib/tax/generated/federal-tax-tables.generated.ts');

const require = createRequire(import.meta.url);
const main = require(SRC);
const { TAX_TABLES, NIIT_RATE, NIIT_THRESHOLD, ADDL_MEDICARE_THRESHOLD, DEFAULT_TAX_YEAR } = main;

// The MCP engine models three filing statuses; the main app models four. Map
// head_of_household -> head_household and drop married_filing_separately.
const STATUS_MAP = {
  single: 'single',
  married_joint: 'married_joint',
  head_of_household: 'head_household',
};
const WEB_STATUSES = Object.values(STATUS_MAP);

function brackets(arr) {
  return arr.map((b) => ({ min: b.min, rate: b.rate }));
}

function perStatus(pick) {
  const out = {};
  for (const [mainStatus, webStatus] of Object.entries(STATUS_MAP)) out[webStatus] = pick(mainStatus);
  return out;
}

function buildYear(year) {
  const t = TAX_TABLES[year];
  const bps = Object.keys(STATUS_MAP).map((s) => t.amt.breakpoint28[s]);
  if (new Set(bps).size !== 1) {
    throw new Error(`AMT 28% breakpoint is not uniform across statuses for ${year}: ${bps}`);
  }
  return {
    ordinary: perStatus((s) => brackets(t.ordinary[s])),
    ltcg: perStatus((s) => brackets(t.ltcg[s])),
    stdDeduction: perStatus((s) => t.stdDeduction[s]),
    amt: {
      rateLower: t.amt.rate1,
      rateUpper: t.amt.rate2,
      phaseoutRate: t.amt.phaseoutRate,
      breakpoint: bps[0],
      exemption: perStatus((s) => t.amt.exemption[s]),
      phaseoutStart: perStatus((s) => t.amt.phaseoutStart[s]),
    },
    fica: {
      ssWageBase: t.fica.ssWageBase,
      ssRate: t.fica.ssRate,
      medicareRate: t.fica.medicareRate,
      addlMedicareRate: t.fica.addlMedicareRate,
    },
    niit: { rate: NIIT_RATE, threshold: perStatus((s) => NIIT_THRESHOLD[s]) },
    addlMedicareThreshold: perStatus((s) => ADDL_MEDICARE_THRESHOLD[s]),
  };
}

const years = Object.keys(TAX_TABLES)
  .map(Number)
  .sort((a, b) => a - b);
const tables = Object.fromEntries(years.map((y) => [y, buildYear(y)]));

const header = `// AlphaLatitude Inc. © 2026
//
// GENERATED FILE - DO NOT EDIT.
// Source of record: the main app's backend/src/calculations/taxTables.js
// (year-keyed federal tax constants, cross-checked against the IRS publications).
// Regenerate with: node scripts/codegen/gen-federal-tax-tables.mjs
// A CI check (--check) fails the build if this file drifts from the source.
import type { FilingStatus } from '../types';

export interface FederalYearTable {
  ordinary: Record<FilingStatus, { min: number; rate: number }[]>;
  ltcg: Record<FilingStatus, { min: number; rate: number }[]>;
  stdDeduction: Record<FilingStatus, number>;
  amt: {
    rateLower: number;
    rateUpper: number;
    phaseoutRate: number;
    breakpoint: number;
    exemption: Record<FilingStatus, number>;
    phaseoutStart: Record<FilingStatus, number>;
  };
  fica: { ssWageBase: number; ssRate: number; medicareRate: number; addlMedicareRate: number };
  niit: { rate: number; threshold: Record<FilingStatus, number> };
  addlMedicareThreshold: Record<FilingStatus, number>;
}

export const DEFAULT_TAX_YEAR = ${DEFAULT_TAX_YEAR};

export const FEDERAL_TAX_TABLES: Record<number, FederalYearTable> = ${JSON.stringify(tables, null, 2)};

export const FEDERAL_TAX_YEARS = [${years.join(', ')}] as const;

export const CURRENT_FEDERAL_TABLE = FEDERAL_TAX_TABLES[DEFAULT_TAX_YEAR];
`;

if (process.argv.includes('--check')) {
  const existing = readFileSync(OUT, 'utf8');
  if (existing !== header) {
    console.error('federal-tax-tables.generated.ts is STALE. Run: node scripts/codegen/gen-federal-tax-tables.mjs');
    process.exit(1);
  }
  console.log('federal-tax-tables.generated.ts is in sync with the source of record.');
} else {
  writeFileSync(OUT, header);
  console.log(`Wrote ${OUT} (${years.length} years: ${years[0]}-${years[years.length - 1]}).`);
}
