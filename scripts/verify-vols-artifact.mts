// AlphaLatitude Inc. © 2026
//
// RELEASE PREFLIGHT: is the published implied-vol artifact actually there, and
// actually current?
//
//   npm run verify:vols
//
// Why this is not a unit test: the whole suite is deliberately hermetic - every
// test seeds a fixture and nothing touches the network, so the suite is green
// whether the producer is deployed, down, or serving something new. That is the
// right default (a CDN outage must not turn CI red), but it leaves exactly one
// thing unchecked: whether the artifact this release READS from exists and is
// fresh. Nothing else in the pipeline notices, because every failure mode of
// the reader degrades silently and identically - to "pass volatility yourself".
// A release could therefore ship a `ticker` shortcut that has been dead for
// weeks and look perfectly healthy.
//
// So this runs at RELEASE time only, against the live URL, on purpose.

import {
  VOLS_URL,
  VOLS_SCHEMA_V,
  type LiveVolEntry,
} from '../lib/data/live-vols';
import { lastTradingDay, lastTradingDayCutoffMs } from '../lib/data/market-calendar';

const TIMEOUT_MS = 15_000; // generous: this is a release gate, not a tool call

function fail(message: string, remedy: string): never {
  console.error(`\nverify:vols FAILED\n  ${message}\n\n  ${remedy}\n`);
  process.exit(1);
}

const now = new Date();
const cutoffMs = lastTradingDayCutoffMs(now);

console.log(`verify:vols  GET ${VOLS_URL}`);
console.log(`             freshness cutoff: ${lastTradingDay(now)} 00:00 UTC (the last trading day)`);

let res: Response;
try {
  res = await fetch(VOLS_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
} catch (err) {
  fail(
    `could not reach ${VOLS_URL} (${err instanceof Error ? err.message : String(err)}).`,
    'Either the CDN is unreachable from here, or the artifact was NEVER DEPLOYED. ' +
      'Check the producer (optionsahoy_web workers, the vols artifact writer) before releasing: ' +
      'a release shipped against a missing artifact makes every `ticker` volatility shortcut a required-field error.',
  );
}

if (res.status === 404) {
  fail(
    `${VOLS_URL} returned 404.`,
    'This reads as NEVER DEPLOYED rather than down. Deploy the producing worker first; ' +
      'until it publishes, `ticker` resolves no volatility on any surface.',
  );
}
if (!res.ok) {
  fail(
    `${VOLS_URL} returned HTTP ${res.status}.`,
    'The artifact exists but the origin/CDN is unhealthy right now (producer DOWN, not undeployed). ' +
      'Re-run once it recovers; do not release against an unreadable feed.',
  );
}

let doc: unknown;
try {
  doc = await res.json();
} catch (err) {
  fail(
    `${VOLS_URL} returned HTTP 200 with a body that is not JSON (${err instanceof Error ? err.message : String(err)}).`,
    'Likely an error page served with a 200, or a truncated upload. The reader refuses this document wholesale.',
  );
}

if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
  fail('the artifact is not a JSON object.', 'The reader refuses it wholesale; check the producer output.');
}
const o = doc as Record<string, unknown>;

if (o.schemaV !== VOLS_SCHEMA_V) {
  fail(
    `schemaV is ${JSON.stringify(o.schemaV)}, this release reads schemaV ${VOLS_SCHEMA_V}.`,
    'The producer bumped the contract. That is a lockstep change: update lib/data/live-vols.ts ' +
      '(and tests/fixtures/vols-artifact-v1.json) BEFORE releasing - a schema mismatch silently ' +
      'resolves nothing rather than misreading a field, which is safe but invisible.',
  );
}

if (o.vols === null || typeof o.vols !== 'object' || Array.isArray(o.vols)) {
  fail('`vols` is missing or is not an object.', 'The reader refuses the document; check the producer output.');
}
const vols = o.vols as Record<string, LiveVolEntry>;
const symbols = Object.keys(vols);
if (symbols.length === 0) {
  fail(
    'the artifact parsed but contains ZERO entries.',
    'The producer ran and published an empty document - a failed upstream pull, most likely. ' +
      'Every ticker resolves nothing in this state.',
  );
}

// The same per-entry gate the reader applies at read time, restated here rather
// than imported: getLiveVol needs a warmed memo and a module-level fetch, and a
// preflight that reported through it could not tell "stale" from "unwarmed".
const fresh = symbols.filter((symbol) => {
  const entry = vols[symbol];
  if (!entry || typeof entry !== 'object') return false;
  const iv = entry.atmIV1y;
  const asOf = entry.asOf;
  if (typeof iv !== 'number' || !Number.isFinite(iv) || iv <= 0 || iv > 5) return false;
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) return false;
  return asOf * 1000 >= cutoffMs;
});

if (fresh.length === 0) {
  const newest = Math.max(
    ...symbols.map((s) => (typeof vols[s]?.asOf === 'number' ? vols[s].asOf : 0)),
  );
  const newestIso = newest > 0 ? new Date(newest * 1000).toISOString() : 'unknown';
  fail(
    `all ${symbols.length} entries are STALE: newest asOf is ${newestIso}, cutoff is ${new Date(cutoffMs).toISOString()}.`,
    'The artifact was deployed but the producer has STOPPED REFRESHING it (this is "down", not "never deployed"). ' +
      'Every entry fails the last-close gate, so `ticker` volatility is dead across every surface. ' +
      'Fix the producer schedule before releasing.',
  );
}

console.log(`             HTTP ${res.status}, schemaV ${VOLS_SCHEMA_V}, ${symbols.length} entries, ${fresh.length} fresh`);
console.log(`ok: ${VOLS_URL}`);
