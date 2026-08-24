// AlphaLatitude Inc. © 2026
//
// US equity-market trading calendar, used by the volatility freshness gate in
// ./live-vols to decide whether a published implied-vol entry is "as of the
// last market close" or stale.
//
// ── The cutoff definition (BOTH SIDES MUST AGREE) ─────────────────────────
// `lastTradingDay(now)` is the most recent day STRICTLY BEFORE now's UTC
// calendar day that is neither a weekend nor a full-closure US market holiday.
// It never returns today, even when today is a trading day.
//
// That "strictly before" rule is not an accident, and it is the same rule the
// producing side uses (optionsahoy_web/workers/src/polygon.ts `lastTradingDay`,
// which walks back one day then skips Saturdays and Sundays). The producer
// stamps each entry's `asOf` with the source chain's timestamp, which is the
// previous session's close until the current session settles. If the consumer
// demanded "as of TODAY's close" it would reject every entry every morning
// until the producer's daily run landed — a self-inflicted outage. Demanding
// "as of the PREVIOUS trading day's close or newer" accepts both the
// freshly-published artifact and yesterday's, and rejects anything two or more
// trading days old, which is exactly the staleness the gate exists to catch.
//
// This module adds holidays, which the producer's weekend-only version lacks.
// Holidays only ever move the cutoff EARLIER (a longer walk back), so the gate
// here is strictly more permissive than a weekend-only one — it can never
// reject an artifact the producer considers current. That is the safe
// direction for a divergence: without holidays, the morning after Thanksgiving
// the cutoff would land on the closed Thursday and reject Wednesday's close,
// which is the freshest data that exists. If the producer later adds holidays,
// the two definitions become identical; until then they agree on every
// non-holiday-adjacent day and disagree only where this side is looser.
//
// Implemented locally on purpose: the producer lives in a separate repo and is
// deployed on its own cadence, so importing across repos would couple two
// independently released artifacts. The SEMANTICS are shared; the code is not.

// Full-closure NYSE/Nasdaq holidays. Half days (the 1pm closes around July 4th,
// Thanksgiving, and Christmas) are deliberately NOT here: the market prints a
// closing chain on those days, so they are trading days for our purposes.

const MS_PER_DAY = 86_400_000;

/** Day-of-month of the `n`th `weekday` (0=Sun..6=Sat) in a UTC month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
}

/** Day-of-month of the LAST `weekday` in a UTC month. */
function lastWeekday(year: number, month: number, weekday: number): number {
  const lastDom = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month, lastDom)).getUTCDay();
  return lastDom - ((lastDow - weekday + 7) % 7);
}

/**
 * Easter Sunday (Gregorian) as [month, day], month 0-based. Anonymous
 * Gregorian algorithm. Computed rather than tabulated so the calendar never
 * expires: a hardcoded holiday list silently turns every date past its last
 * year into "a trading day", and this gate would then accept stale vols.
 */
function easter(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month - 1, day];
}

/**
 * NYSE weekend-observance rule: a fixed-date holiday landing on Saturday is
 * observed the preceding Friday, on Sunday the following Monday. New Year's
 * Day is the documented exception — the exchange does NOT close on December 31
 * for a Saturday January 1 — and is handled by the caller.
 */
function observed(year: number, month: number, day: number): [number, number, number] {
  const dow = new Date(Date.UTC(year, month, day)).getUTCDay();
  if (dow === 6) {
    const d = new Date(Date.UTC(year, month, day - 1));
    return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  }
  if (dow === 0) {
    const d = new Date(Date.UTC(year, month, day + 1));
    return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  }
  return [year, month, day];
}

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Per-year holiday sets are memoized: the walk-back loop hits the same year
// (occasionally two) over and over, and the set is a dozen date strings.
const HOLIDAY_CACHE = new Map<number, ReadonlySet<string>>();

/** The observed full-closure holidays for one calendar year, as YYYY-MM-DD. */
export function marketHolidays(year: number): ReadonlySet<string> {
  const cached = HOLIDAY_CACHE.get(year);
  if (cached) return cached;
  const out = new Set<string>();
  const add = (m: number, d: number) => {
    const [oy, om, od] = observed(year, m, d);
    out.add(iso(oy, om, od));
  };
  const addFixedDow = (m: number, d: number) => out.add(iso(year, m, d));

  // New Year's Day: Sunday -> observed Monday Jan 2; Saturday -> NOT observed
  // (the exchange does not close the preceding December 31).
  const nyDow = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  if (nyDow === 0) addFixedDow(0, 2);
  else if (nyDow !== 6) addFixedDow(0, 1);

  addFixedDow(0, nthWeekday(year, 0, 1, 3)); // MLK Jr Day — 3rd Monday of January
  addFixedDow(1, nthWeekday(year, 1, 1, 3)); // Washington's Birthday — 3rd Monday of February

  const [em, ed] = easter(year);
  const goodFriday = new Date(Date.UTC(year, em, ed - 2));
  out.add(iso(goodFriday.getUTCFullYear(), goodFriday.getUTCMonth(), goodFriday.getUTCDate()));

  addFixedDow(4, lastWeekday(year, 4, 1)); // Memorial Day — last Monday of May
  add(5, 19); // Juneteenth
  add(6, 4); // Independence Day
  addFixedDow(8, nthWeekday(year, 8, 1, 1)); // Labor Day — 1st Monday of September
  addFixedDow(10, nthWeekday(year, 10, 4, 4)); // Thanksgiving — 4th Thursday of November
  add(11, 25); // Christmas

  HOLIDAY_CACHE.set(year, out);
  return out;
}

/** True when the given UTC calendar day is a weekend or a full-closure holiday. */
export function isMarketClosed(day: Date): boolean {
  const dow = day.getUTCDay();
  if (dow === 0 || dow === 6) return true;
  const y = day.getUTCFullYear();
  return marketHolidays(y).has(iso(y, day.getUTCMonth(), day.getUTCDate()));
}

/**
 * The most recent trading day strictly before `now`'s UTC calendar day, as
 * YYYY-MM-DD. See the cutoff note at the top of this file — the "strictly
 * before" part is load-bearing and shared with the producer.
 */
export function lastTradingDay(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - MS_PER_DAY);
  // Longest real closure run is Christmas/New Year plus flanking weekends;
  // 14 steps is generous headroom and makes a calendar bug terminate loudly
  // (a wrong-but-bounded date) rather than hang a request.
  for (let i = 0; i < 14 && isMarketClosed(d); i += 1) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Epoch ms at 00:00 UTC of `lastTradingDay(now)`: the freshness cutoff. */
export function lastTradingDayCutoffMs(now: Date): number {
  const [y, m, d] = lastTradingDay(now).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
