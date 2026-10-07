// AlphaLatitude Inc. © 2026
//
// How each state turns income into STATE taxable income and tax, tax year 2026.
//
// The calculators take FEDERAL taxable income. Walking a state's brackets on
// that number (what the engine used to do) is wrong in two directions: most
// states start from federal AGI and allow their own, smaller deductions, so
// state tax was understated; a few start from federal taxable income and add
// things back. Each rule below is the state's own: its starting point, its
// standard deduction and personal exemption (with their income phaseouts),
// credits, and the add-ons and special rates that change the tax at the
// incomes these tools serve. The bracket schedules stay in ./states/*.json.
//
// Assumptions, stated once: the filer takes the standard deduction at the
// state level, has no dependents, is under 65, and on a joint return one
// spouse earns the income. Local income taxes (Maryland counties, Indiana
// counties, New York City, Philadelphia, Ohio municipalities, Michigan cities,
// Kentucky occupational taxes, Iowa school districts, Portland) are not
// modeled. Credits that only matter below about $65,000 of income
// (Connecticut's personal tax credit, Idaho's food credit, low-income credits)
// are not modeled.
//
// Sources: every figure is from the state's own 2026 publication or statute
// (research files of 2026-10-06, primary-source URLs below). Figures the state
// had not published by then are marked PROVISIONAL with the basis used.

import type { FilingStatus } from './types';

export interface StateTaxContext {
  status: FilingStatus;
  /** Federal AGI, including the income being priced. */
  agi: number;
  /** Federal taxable income, including the income being priced. */
  federalTaxableIncome: number;
  federalStandardDeduction: number;
  /** The event's long- and short-term capital gain, and W-2 income. */
  longTermGain: number;
  shortTermGain: number;
  /** Federal regular income tax (ordinary + capital gains; no AMT) and NIIT. */
  federalIncomeTax: number;
  federalNiit: number;
}

export interface StateRules {
  start: 'federal_agi' | 'federal_taxable_income' | 'state_defined_income';
  /** Amounts added to the starting income (Colorado's deduction add-back). */
  additions?: (c: StateTaxContext) => number;
  /** Amounts subtracted before deductions (capital gain exclusions). */
  subtractions?: (c: StateTaxContext) => number;
  standardDeduction?: (c: StateTaxContext) => number;
  exemptionDeduction?: (c: StateTaxContext) => number;
  /** Deduction for federal income tax paid (AL, MO, OR). */
  federalTaxDeduction?: (c: StateTaxContext) => number;
  /**
   * Tax on state taxable income when it is not a plain bracket walk (New
   * York's recapture, Hawaii's and Montana's capital gain rates, Vermont's
   * minimum tax, Massachusetts' 8.5% short-term rate).
   */
  tax?: (ti: number, c: StateTaxContext, schedule: (x: number) => number) => number;
  /** Tax added on top (CT recapture, MA surtax, ME surcharge, MN NIIT, OH base). */
  addOns?: (ti: number, c: StateTaxContext) => number;
  /** Nonrefundable credits (exemption credits). */
  credits?: (ti: number, c: StateTaxContext) => number;
  /**
   * The state taxes an incentive stock option's spread as pay at exercise
   * (federal law defers it to the sale), so the later gain runs from the
   * exercise-date value, not the strike.
   */
  isoSpreadTaxedAtExercise?: boolean;
  sources: string[];
}

type ByStatus = Record<FilingStatus, number>;
const by = (single: number, married_joint: number, head_household: number): ByStatus => ({
  single,
  married_joint,
  head_household,
});
const pick = (t: ByStatus) => (c: StateTaxContext) => t[c.status];
const perPerson = (amount: number, hohCount = 1) => (c: StateTaxContext) =>
  amount * (c.status === 'married_joint' ? 2 : c.status === 'head_household' ? hohCount : 1);
const federalSd = (c: StateTaxContext) => c.federalStandardDeduction;
const ceilSteps = (excess: number, step: number) => (excess <= 0 ? 0 : Math.ceil(excess / step));

// ---------------------------------------------------------------------------
// Multi-line rules, kept as named functions so each can be tested on its own.
// ---------------------------------------------------------------------------

/** Alabama standard deduction: an AGI-graded schedule with a floor. */
export function alStandardDeduction(c: StateTaxContext): number {
  const t = {
    single: { max: 3_000, step: 25, floor: 2_500 },
    married_joint: { max: 8_500, step: 175, floor: 5_000 },
    head_household: { max: 5_200, step: 135, floor: 2_500 },
  }[c.status];
  if (c.agi <= 25_999) return t.max;
  return Math.max(t.floor, t.max - t.step * Math.ceil((c.agi - 25_999) / 500));
}

/** California personal exemption credit, $6 less per credit for each $2,500 of federal AGI over the threshold. */
export function caExemptionCredit(c: StateTaxContext): number {
  // PROVISIONAL thresholds: FTB publishes the 2026 figures in late December;
  // these are the 2025 thresholds indexed by FTB's announced 3.4%.
  const threshold = by(260_778, 521_561, 391_173)[c.status];
  const count = c.status === 'married_joint' ? 2 : 1;
  const steps = ceilSteps(c.agi - threshold, 2_500);
  return Math.max(0, count * (158 - 6 * steps));
}

/** Colorado: above $300,000 of federal AGI, add back the federal deduction over $1,000 ($2,000 joint). */
export function coDeductionAddback(c: StateTaxContext): number {
  if (c.agi <= 300_000) return 0;
  const limit = c.status === 'married_joint' ? 2_000 : 1_000;
  return Math.max(0, c.federalStandardDeduction - limit);
}

/** Connecticut personal exemption: $1,000 less for each $1,000 of CT AGI over the threshold. */
export function ctExemption(c: StateTaxContext): number {
  const max = by(15_000, 24_000, 19_000)[c.status];
  const threshold = by(30_000, 48_000, 38_000)[c.status];
  return Math.max(0, max - 1_000 * ceilSteps(c.agi - threshold, 1_000));
}

type Tier = { threshold: number; step: number; perStep: number; cap: number };
const tierAmount = (agi: number, t: Tier) => Math.min(t.cap, t.perStep * ceilSteps(agi - t.threshold, t.step));

/** Connecticut Table C (2% rate phase-out) plus Table D (recapture), added to tax by CT AGI. */
export function ctAddBacks(c: StateTaxContext): number {
  const tableC: Record<FilingStatus, Tier> = {
    single: { threshold: 56_500, step: 5_000, perStep: 25, cap: 250 },
    married_joint: { threshold: 100_500, step: 5_000, perStep: 50, cap: 500 },
    head_household: { threshold: 78_500, step: 4_000, perStep: 40, cap: 400 },
  };
  const tableD: Record<FilingStatus, Tier[]> = {
    single: [
      { threshold: 105_000, step: 5_000, perStep: 25, cap: 250 },
      { threshold: 200_000, step: 5_000, perStep: 90, cap: 2_700 },
      { threshold: 500_000, step: 5_000, perStep: 50, cap: 450 },
    ],
    married_joint: [
      { threshold: 210_000, step: 10_000, perStep: 50, cap: 500 },
      { threshold: 400_000, step: 10_000, perStep: 180, cap: 5_400 },
      { threshold: 1_000_000, step: 10_000, perStep: 100, cap: 900 },
    ],
    head_household: [
      { threshold: 168_000, step: 8_000, perStep: 40, cap: 400 },
      { threshold: 320_000, step: 8_000, perStep: 140, cap: 4_200 },
      { threshold: 800_000, step: 8_000, perStep: 80, cap: 720 },
    ],
  };
  return (
    tierAmount(c.agi, tableC[c.status]) +
    tableD[c.status].reduce((sum, t) => sum + tierAmount(c.agi, t), 0)
  );
}

/** Hawaii: net capital gain is taxed at no more than 7.25% once taxable income passes the threshold. */
export function hiTax(ti: number, c: StateTaxContext, schedule: (x: number) => number): number {
  const threshold = by(24_000, 48_000, 36_000)[c.status];
  const gain = Math.min(c.longTermGain, ti);
  if (gain <= 0 || ti <= threshold) return schedule(ti);
  const base = Math.max(ti - gain, threshold);
  return Math.min(schedule(base) + 0.0725 * (ti - base), schedule(ti));
}

/** Illinois exemption allowance: all of it is lost above $250,000 of federal AGI ($500,000 joint). */
export function ilExemption(c: StateTaxContext): number {
  const cliff = c.status === 'married_joint' ? 500_000 : 250_000;
  return c.agi > cliff ? 0 : perPerson(2_925)(c);
}

/** Massachusetts: 5% on most income, 8.5% on short-term gains, plus the 4% surtax. */
export function maTax(ti: number, c: StateTaxContext): number {
  const shortTerm = Math.min(c.shortTermGain, ti);
  const surtax = 0.04 * Math.max(0, ti - 1_107_750); // one threshold for every filing status
  return 0.05 * (ti - shortTerm) + 0.085 * shortTerm + surtax;
}

/** Maryland personal exemption: $3,200 each, stepping down by federal AGI. */
export function mdExemption(c: StateTaxContext): number {
  const t = c.status === 'single' ? 100_000 : 150_000;
  const each = c.agi <= t ? 3_200 : c.agi <= t + 25_000 ? 1_600 : c.agi <= t + 50_000 ? 800 : 0;
  return each * (c.status === 'married_joint' ? 2 : 1);
}

const phaseFraction = (agi: number, threshold: number, denominator: number) =>
  Math.round(Math.min(1, Math.max(0, agi - threshold) / denominator) * 10_000) / 10_000;

/** Maine standard deduction, phased out on Maine AGI (fraction rounded to 4 places). */
export function meStandardDeduction(c: StateTaxContext): number {
  const sd = by(15_700, 31_400, 23_550)[c.status];
  const [threshold, denominator] = {
    single: [102_250, 75_000],
    married_joint: [204_550, 150_000],
    head_household: [153_400, 112_500],
  }[c.status];
  return sd * (1 - phaseFraction(c.agi, threshold, denominator));
}

/** Maine personal exemption, phased out on Maine AGI. */
export function meExemption(c: StateTaxContext): number {
  const total = perPerson(5_300)(c);
  const threshold = by(341_000, 409_150, 375_050)[c.status];
  return total * (1 - phaseFraction(c.agi, threshold, 125_000));
}

/** Minnesota standard deduction: 3% of AGI over T1, plus 10% over T2, capped at 80% of it. */
export function mnStandardDeduction(c: StateTaxContext): number {
  const sd = by(15_300, 30_600, 23_000)[c.status];
  const t1 = 244_400;
  const t2 = 337_800;
  const reduction = 0.03 * Math.max(0, Math.min(c.agi, t2) - t1) + 0.1 * Math.max(0, c.agi - t2);
  return sd - Math.min(reduction, 0.8 * sd);
}

/** Missouri: deduct a percentage of federal income tax, by Missouri AGI, capped. */
export function moFederalTaxDeduction(c: StateTaxContext): number {
  const moAgi = c.agi - (c.longTermGain + c.shortTermGain);
  const pct =
    moAgi <= 25_000 ? 0.35 : moAgi <= 50_000 ? 0.25 : moAgi <= 100_000 ? 0.15 : moAgi <= 125_000 ? 0.05 : 0;
  return Math.min(pct * c.federalIncomeTax, c.status === 'married_joint' ? 10_000 : 5_000);
}

/** Montana: long-term gains at 3% inside the first bracket, 4.1% above; the rest at ordinary rates. */
export function mtTax(ti: number, c: StateTaxContext, schedule: (x: number) => number): number {
  const gain = Math.min(c.longTermGain, ti);
  const ordinary = ti - gain;
  const firstBracketTop = by(47_500, 95_000, 71_250)[c.status];
  const atThree = Math.max(0, Math.min(gain, firstBracketTop - ordinary));
  return schedule(ordinary) + 0.03 * atThree + 0.041 * (gain - atThree);
}

/** New Mexico low- and middle-income exemption (gone above $36,667 single / $55,000 joint). */
export function nmExemption(c: StateTaxContext): number {
  const [base, rate, ceiling] = c.status === 'single' ? [20_000, 0.15, 36_667] : [30_000, 0.1, 55_000];
  if (c.agi > ceiling) return 0;
  return Math.max(0, 2_500 - rate * Math.max(0, c.agi - base)) * (c.status === 'married_joint' ? 2 : 1);
}

type NyTier = { tiOver: number; agiOver: number; base: number; increment: number };
const NY_RECAPTURE: Record<FilingStatus, { phaseInMax: number; flatRate: number; tiers: NyTier[] }> = {
  single: {
    phaseInMax: 215_400,
    flatRate: 0.059,
    tiers: [
      { tiOver: 215_400, agiOver: 215_400, base: 567, increment: 2_047 },
      { tiOver: 1_077_550, agiOver: 1_077_550, base: 2_614, increment: 30_172 },
      { tiOver: 5_000_000, agiOver: 5_000_000, base: 32_786, increment: 32_500 },
    ],
  },
  married_joint: {
    phaseInMax: 161_550,
    flatRate: 0.054,
    tiers: [
      { tiOver: 161_550, agiOver: 161_550, base: 333, increment: 807 },
      { tiOver: 323_200, agiOver: 323_200, base: 1_140, increment: 3_071 },
      { tiOver: 2_155_350, agiOver: 2_155_350, base: 4_211, increment: 60_350 },
      { tiOver: 5_000_000, agiOver: 5_000_000, base: 64_561, increment: 32_500 },
    ],
  },
  head_household: {
    phaseInMax: 269_300,
    flatRate: 0.059,
    tiers: [
      { tiOver: 269_300, agiOver: 269_300, base: 787, increment: 2_559 },
      { tiOver: 1_616_450, agiOver: 1_616_450, base: 3_346, increment: 45_260 },
      { tiOver: 5_000_000, agiOver: 5_000_000, base: 48_606, increment: 32_500 },
    ],
  },
};

/** New York tax with the supplemental tax (benefit recapture), Tax Law 601(d-1). */
export function nyTax(ti: number, c: StateTaxContext, schedule: (x: number) => number): number {
  const sched = schedule(ti);
  const nyagi = c.agi;
  if (nyagi <= 107_650) return sched;
  if (nyagi > 25_000_000) return 0.109 * ti;
  const r = NY_RECAPTURE[c.status];
  if (ti <= r.phaseInMax) {
    const flat = r.flatRate * ti;
    if (nyagi >= 157_650) return flat;
    const fraction = Math.round(((nyagi - 107_650) / 50_000) * 10_000) / 10_000;
    return sched + (flat - sched) * fraction;
  }
  const tier = [...r.tiers].reverse().find((t) => ti > t.tiOver)!;
  const fraction = Math.round((Math.min(Math.max(nyagi - tier.agiOver, 0), 50_000) / 50_000) * 10_000) / 10_000;
  return sched + tier.base + tier.increment * fraction;
}

/** Ohio personal exemption: $1,900 each from $80,000 of income, none at $500,000. */
export function ohExemption(c: StateTaxContext): number {
  const each = c.agi <= 40_000 ? 2_400 : c.agi <= 80_000 ? 2_150 : c.agi < 500_000 ? 1_900 : 0;
  return each * (c.status === 'married_joint' ? 2 : 1);
}

/** Oregon: subtract federal income tax up to $8,750, stepped down by federal AGI. */
export function orFederalTaxDeduction(c: StateTaxContext): number {
  const steps = c.status === 'single' ? [125_000, 130_000, 135_000, 140_000, 145_000] : [250_000, 260_000, 270_000, 280_000, 290_000];
  const fractions = [1, 0.8, 0.6, 0.4, 0.2, 0];
  const i = steps.findIndex((s) => c.agi < s);
  const fraction = fractions[i === -1 ? 5 : i];
  return Math.min(c.federalIncomeTax, 8_750 * fraction);
}

/** Rhode Island: deduction and exemptions lose 20% for each $7,450 of AGI over $261,000. */
export function riPhaseFactor(c: StateTaxContext): number {
  const n = ceilSteps(c.agi - 261_000, 7_450);
  return n === 0 ? 1 : n >= 5 ? 0 : 1 - 0.2 * n;
}

/** South Carolina Income Adjusted Deduction (Act 110 of 2026), phased out linearly on federal AGI. */
export function scDeduction(c: StateTaxContext): number {
  const [base, start, denominator] = {
    single: [15_000, 40_000, 55_000],
    married_joint: [30_000, 80_000, 110_000],
    head_household: [22_500, 60_000, 82_500],
  }[c.status];
  const fraction = Math.max(0, c.agi - start) / denominator;
  if (fraction >= 1) return 0;
  return base - Math.floor((base * fraction) / 10) * 10;
}

/** Utah taxpayer tax credit: 6% of the federal standard deduction, less 1.3% of income over a base. */
export function utCredit(ti: number, c: StateTaxContext): number {
  const base = by(18_696, 37_392, 28_045)[c.status]; // PROVISIONAL: 2026 TC-40 drafts of 9/28 and 10/5/2026
  return Math.max(0, 0.06 * c.federalStandardDeduction - 0.013 * Math.max(0, ti - base));
}

/** Wisconsin sliding-scale standard deduction (Wis. Stat. 71.05(22)(dp)). */
export function wiStandardDeduction(c: StateTaxContext): number {
  // Measured on Wisconsin income: federal AGI less the 30% capital gain exclusion.
  const wi = c.agi - 0.3 * c.longTermGain;
  const single = Math.max(0, 13_960 - 0.12 * Math.max(0, wi - 20_120));
  if (c.status === 'single') return wi <= 20_119 ? 13_960 : single;
  if (c.status === 'married_joint') return wi <= 29_039 ? 25_840 : Math.max(0, 25_840 - 0.19778 * (wi - 29_040));
  if (wi <= 20_119) return 18_030;
  return Math.max(single, 18_030 - 0.22515 * (wi - 20_120));
}

// ---------------------------------------------------------------------------
// The registry. States with no wage income tax (AK, FL, NV, NH, SD, TN, TX,
// WY) and Washington (capital-gains-only tax, handled in state-tax.ts) are
// absent; they owe no state income tax here.
// ---------------------------------------------------------------------------

export function stateTaxesIsoSpreadAtExercise(stateCode: string): boolean {
  return STATE_RULES_2026[stateCode]?.isoSpreadTaxedAtExercise === true;
}

export const STATE_RULES_2026: Record<string, StateRules> = {
  AL: {
    start: 'state_defined_income',
    standardDeduction: alStandardDeduction,
    exemptionDeduction: pick(by(1_500, 3_000, 3_000)),
    // Federal income tax after credits, including the NIIT; uncapped (Form 40 line 12).
    federalTaxDeduction: (c) => c.federalIncomeTax + c.federalNiit,
    sources: ['https://www.revenue.alabama.gov/wp-content/uploads/2026/01/whbooklet_0126.pdf'],
  },
  AR: {
    start: 'state_defined_income',
    // Ark. Code 26-51-201(a)(4) (Act 1, 2026 1st Ex. Sess.): net income at or below
    // $94,700 uses its own table; above it, AR.json's 2% / 3.7% table, less a
    // bracket adjustment of $300 - $10 per $100 (or part) over $94,700, gone at $97,601.
    tax: (ti, _c, schedule) => {
      if (ti <= 94_700) {
        const low: [number, number][] = [[5_599, 0.02], [11_199, 0.03], [15_999, 0.034], [26_399, 0.037]];
        return low.reduce((t, [min, rate], i) => {
          const top = i + 1 < low.length ? low[i + 1][0] : Infinity;
          return t + Math.max(0, Math.min(ti, top) - min) * rate;
        }, 0);
      }
      const adjustment = ti <= 97_600 ? 300 - 10 * Math.ceil((ti - 94_700) / 100) : 0;
      return schedule(ti) - adjustment;
    },
    // PROVISIONAL: the 2025 amount; Arkansas indexes it and had not published 2026.
    standardDeduction: pick(by(2_470, 4_940, 2_470)),
    // Half of long-term gain is taxable; gain over $10 million is exempt (AR1000D).
    subtractions: (c) => 0.5 * Math.min(c.longTermGain, 10_000_000) + Math.max(0, c.longTermGain - 10_000_000),
    credits: (_ti, c) => perPerson(29, 2)(c),
    sources: ['https://www.dfa.arkansas.gov/wp-content/uploads/whformula_2026.pdf'],
  },
  AZ: {
    start: 'federal_agi',
    standardDeduction: federalSd, // A.R.S. 43-1041(H): indexed like the federal amount
    // 25% of long-term gain on assets acquired after 2011 (assumed for equity granted since).
    subtractions: (c) => 0.25 * c.longTermGain,
    sources: ['https://www.azleg.gov/ars/43/01041.htm'],
  },
  CA: {
    start: 'federal_agi',
    standardDeduction: pick(by(5_900, 11_800, 11_800)),
    credits: (_ti, c) => caExemptionCredit(c),
    sources: ['https://www.ftb.ca.gov/about-ftb/newsroom/tax-news/index.html'],
  },
  CO: {
    start: 'federal_taxable_income',
    additions: coDeductionAddback,
    sources: ['https://tax.colorado.gov/individual-income-tax-guide'],
  },
  CT: {
    start: 'federal_agi',
    exemptionDeduction: ctExemption,
    addOns: (_ti, c) => ctAddBacks(c),
    sources: ['https://portal.ct.gov/-/media/drs/publications/pubsip/2026/ip-2026-7.pdf'],
  },
  DC: {
    start: 'federal_agi',
    // PROVISIONAL: D.C. Act 26-416 keeps $15,000 / $30,000 / $22,500 for 2026 on
    // a literal reading of its indexing clause; OTR had not published 2026.
    standardDeduction: pick(by(15_000, 30_000, 22_500)),
    sources: ['https://code.dccouncil.gov/us/dc/council/acts/26-416'],
  },
  DE: {
    start: 'federal_agi',
    standardDeduction: pick(by(3_250, 6_500, 3_250)),
    credits: (_ti, c) => perPerson(110)(c),
    sources: ['https://revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf'],
  },
  GA: {
    start: 'federal_agi',
    standardDeduction: pick(by(15_000, 30_000, 15_000)), // HB 463, retroactive to 1/1/2026
    sources: ['https://gov.georgia.gov/document/2026-signed-legislation/hb-463/download'],
  },
  HI: {
    start: 'federal_agi',
    standardDeduction: pick(by(8_000, 16_000, 12_000)),
    exemptionDeduction: perPerson(1_144),
    tax: hiTax,
    sources: ['https://files.hawaii.gov/tax/forms/2025/n11ins.pdf'],
  },
  IA: {
    start: 'federal_taxable_income',
    credits: (_ti, c) => perPerson(40, 2)(c),
    sources: ['https://www.legis.iowa.gov/docs/code/422.12.pdf'],
  },
  ID: {
    start: 'federal_agi',
    standardDeduction: federalSd,
    addOns: () => 10, // Permanent Building Fund tax, per return
    sources: ['https://tax.idaho.gov/wp-content/uploads/pubs/EPB00744/EPB00744_07-23-2026.pdf'],
  },
  IL: {
    start: 'federal_agi',
    exemptionDeduction: ilExemption,
    sources: ['https://tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/bulletins/documents/2026/fy-2026-15.pdf'],
  },
  IN: {
    start: 'federal_agi',
    exemptionDeduction: perPerson(1_000),
    sources: ['https://secure.in.gov/dor/files/dn01.pdf'],
  },
  KS: {
    start: 'federal_agi',
    standardDeduction: pick(by(3_605, 8_240, 6_180)),
    exemptionDeduction: pick(by(9_160, 18_320, 11_480)),
    sources: ['https://ksrevisor.gov/statutes/chapters/ch79/079_032_0121.html'],
  },
  KY: {
    start: 'federal_agi',
    standardDeduction: () => 3_360, // one per joint return
    sources: ['https://revenue.ky.gov/News/Pages/Kentucky-DOR-Announces-2026-Standard-Deduction.aspx'],
  },
  LA: {
    start: 'federal_agi',
    standardDeduction: pick(by(12_838, 25_676, 25_676)),
    sources: ['https://dam.ldr.la.gov/lawspolicies/RIB%2026-019.pdf'],
  },
  MA: {
    start: 'state_defined_income',
    // Exemption, plus Social Security and Medicare paid up to $2,000 (one earner).
    exemptionDeduction: (c) => by(4_400, 8_800, 6_800)[c.status] + 2_000,
    tax: (ti, c) => maTax(ti, c),
    sources: ['https://malegislature.gov/Laws/GeneralLaws/PartI/TitleIX/Chapter62/Section3'],
  },
  MD: {
    start: 'federal_agi',
    // Single is published ($3,400); joint and head of household are PROVISIONAL,
    // computed from the 10-217(c) indexing formula that reproduces the single figure.
    standardDeduction: pick(by(3_400, 6_850, 6_850)),
    exemptionDeduction: mdExemption,
    // Tax-General 10-105(a)(3): 2% of net capital gain (long-term gain; not
    // short-term or wages) once federal AGI, including the gain, exceeds
    // $350,000, every filing status. A cliff: the whole gain is taxed.
    addOns: (_ti, c) => (c.agi > 350_000 ? 0.02 * c.longTermGain : 0),
    sources: [
      'https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gtg&section=10-217&enactments=false',
      'https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gtg&section=10-105&enactments=false',
    ],
  },
  ME: {
    start: 'federal_agi',
    standardDeduction: meStandardDeduction,
    exemptionDeduction: meExemption,
    // New 2026 surcharge, 36 M.R.S. 5111(7).
    addOns: (ti, c) => 0.02 * Math.max(0, ti - (c.status === 'single' ? 1_000_000 : 1_500_000)),
    sources: ['https://legislature.maine.gov/statutes/36/title36sec5124-C.html'],
  },
  MI: {
    start: 'federal_agi',
    exemptionDeduction: (c) => 5_900 * (c.status === 'married_joint' ? 2 : 1),
    sources: ['https://legislature.mi.gov/Laws/MCL?objectName=mcl-206-30'],
  },
  MN: {
    start: 'federal_agi',
    standardDeduction: mnStandardDeduction,
    // 1% on net investment income over $1,000,000 (Schedule NIIT).
    addOns: (_ti, c) => 0.01 * Math.max(0, c.longTermGain + c.shortTermGain - 1_000_000),
    sources: ['https://www.revenue.state.mn.us/sites/default/files/2025-12/inflation-adjusted-amounts-2026.pdf'],
  },
  MO: {
    start: 'federal_agi',
    standardDeduction: (c) => c.federalStandardDeduction + (c.status === 'head_household' ? 1_400 : 0),
    subtractions: (c) => c.longTermGain + c.shortTermGain, // 100% of capital gain, from 2025
    federalTaxDeduction: moFederalTaxDeduction,
    sources: ['https://revisor.mo.gov/main/OneSection.aspx?section=143.121'],
  },
  MS: {
    start: 'state_defined_income',
    standardDeduction: pick(by(2_300, 4_600, 3_400)),
    exemptionDeduction: pick(by(6_000, 12_000, 8_000)),
    sources: ['https://www.dor.ms.gov/sites/default/files/tax-forms/business/89700251revised1.13.2026.pdf'],
  },
  MT: {
    start: 'federal_taxable_income',
    tax: mtTax,
    sources: ['https://revenue.mt.gov/news/recent-news/HB-337'],
  },
  NC: {
    start: 'federal_agi',
    standardDeduction: pick(by(12_750, 25_500, 19_125)),
    sources: ['https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_105/GS_105-153.5.html'],
  },
  ND: {
    start: 'federal_taxable_income',
    subtractions: (c) => 0.4 * c.longTermGain,
    sources: ['https://www.tax.nd.gov/sites/www/files/documents/forms/individual/2025-iit/2025-individual-income-tax-booklet.pdf'],
  },
  NE: {
    start: 'federal_agi',
    standardDeduction: pick(by(8_850, 17_700, 12_950)),
    credits: (_ti, c) => perPerson(176)(c),
    sources: ['https://nebraskalegislature.gov/laws/statutes.php?statute=77-2716.01'],
  },
  NJ: {
    start: 'state_defined_income',
    exemptionDeduction: perPerson(1_000),
    sources: ['https://www.nj.gov/treasury/taxation/pdf/current/1040i.pdf'],
  },
  NM: {
    start: 'federal_agi',
    standardDeduction: federalSd,
    exemptionDeduction: nmExemption,
    subtractions: (c) => Math.min(c.longTermGain, 2_500), // PIT-ADJ line 16
    sources: ['https://realfile.tax.newmexico.gov/2025pit-1-ins.pdf'],
  },
  NY: {
    start: 'federal_agi',
    standardDeduction: pick(by(8_000, 16_050, 11_200)),
    tax: nyTax,
    sources: ['https://www.tax.ny.gov/pdf/current_forms/it/it201i.pdf'],
  },
  OH: {
    start: 'federal_agi',
    exemptionDeduction: ohExemption,
    // $332 plus 2.75% over $26,050 (R.C. 5747.02(A)(3)(c), HB 96); the 2.75% is in OH.json.
    addOns: (ti) => (ti > 26_050 ? 332 : 0),
    sources: ['https://www.lsc.ohio.gov/assets/legislation/136/hb96/en0/files/hb96-tax-bill-analysis-as-enacted-136th-general-assembly.pdf'],
  },
  OK: {
    start: 'federal_agi',
    standardDeduction: pick(by(6_350, 12_700, 9_350)),
    exemptionDeduction: perPerson(1_000),
    sources: ['http://webserver1.lsb.state.ok.us/cf_pdf/2025-26%20ENR/hB/HB2764%20ENR.PDF'],
  },
  OR: {
    start: 'federal_agi',
    // Head of household is PROVISIONAL ($4,685, ORS 316.695 indexing formula).
    standardDeduction: pick(by(2_910, 5_820, 4_685)),
    federalTaxDeduction: orFederalTaxDeduction,
    credits: (_ti, c) => (c.agi > (c.status === 'single' ? 100_000 : 200_000) ? 0 : perPerson(263)(c)),
    sources: ['https://www.oregon.gov/dor/forms/FormsPubs/withholding-tax-formulas_206-436_2026.pdf'],
  },
  PA: {
    start: 'state_defined_income',
    // "Incentive, statutory, and non-statutory stock options are taxable as
    // Pennsylvania compensation on the earliest of ... Date of exercise"
    // (PA Personal Income Tax Guide, Gross Compensation).
    isoSpreadTaxedAtExercise: true,
    sources: [
      'https://www.pa.gov/content/dam/copapwp-pagov/en/revenue/documents/formsandpublications/formsforindividuals/pit/documents/2025/2025_pa-40in.pdf',
      'https://www.pa.gov/content/dam/copapwp-pagov/en/revenue/documents/formsandpublications/papersonalincometaxguide/documents/pitguide_grosscompensation.pdf',
    ],
  },
  RI: {
    start: 'federal_agi',
    standardDeduction: (c) => by(11_200, 22_400, 16_800)[c.status] * riPhaseFactor(c),
    exemptionDeduction: (c) => perPerson(5_250)(c) * riPhaseFactor(c),
    sources: ['https://tax.ri.gov/sites/g/files/xkgbur541/files/2025-11/ADV_2025_22_Inflation_Adjustments.pdf'],
  },
  SC: {
    start: 'federal_agi',
    standardDeduction: scDeduction,
    subtractions: (c) => 0.44 * c.longTermGain,
    sources: ['https://www.scstatehouse.gov/sess126_2025-2026/bills/4216.htm'],
  },
  UT: {
    start: 'federal_agi',
    credits: utCredit,
    sources: ['https://files.tax.utah.gov/tax/forms/drafts/tc-40inst.pdf'],
  },
  VA: {
    start: 'federal_agi',
    standardDeduction: pick(by(8_750, 17_500, 8_750)),
    exemptionDeduction: perPerson(930),
    sources: ['https://law.lis.virginia.gov/vacode/title58.1/chapter3/section58.1-322.03/'],
  },
  VT: {
    start: 'federal_agi',
    // PROVISIONAL until the 2026 IN-111: 32 V.S.A. 5811(21)(C)-(D) amounts
    // ($6,000 / $12,000 / $9,000; exemption $4,150) times the 2026 CPI-U factor
    // 1.311486, rounded down to $50. The same method reproduces Vermont's
    // published 2024 and 2025 figures and its 2026 IN-114 bracket thresholds.
    standardDeduction: pick(by(7_850, 15_700, 11_800)),
    exemptionDeduction: perPerson(5_400),
    // Flat capital gain exclusion, 32 V.S.A. 5811(21)(B)(ii): the first $5,000
    // of long-term gain, capped at 40% of federal taxable income. (The 40%
    // alternative excludes publicly traded stock.)
    subtractions: (c) => Math.min(c.longTermGain, 5_000, 0.4 * c.federalTaxableIncome),
    // Above $150,000 of AGI, tax is at least 3% of AGI (32 V.S.A. 5822(a)(6)).
    tax: (ti, c, schedule) => (c.agi > 150_000 ? Math.max(schedule(ti), 0.03 * c.agi) : schedule(ti)),
    sources: ['https://legislature.vermont.gov/statutes/section/32/151/05811'],
  },
  WI: {
    start: 'federal_agi',
    standardDeduction: wiStandardDeduction,
    exemptionDeduction: perPerson(700),
    subtractions: (c) => 0.3 * c.longTermGain,
    sources: ['https://www.revenue.wi.gov/TaxForms2026/2026-Form1-ES-Inst.pdf'],
  },
  WV: {
    start: 'federal_agi',
    exemptionDeduction: perPerson(2_000),
    sources: ['https://www.wvlegislature.gov/Bill_Text_HTML/2026_SESSIONS/RS/bills/sb392%20sub1%20enr.pdf'],
  },
};
