// AlphaLatitude Inc. © 2026
//
// State Alternative Minimum Tax registry.
//
// Two kinds of state AMT live in this registry, distinguished by `kind`:
//
//   kind: 'simple' (default)  CA, CO, MN
//     Single flat rate applied to (AMTI − state exemption), with state-specific
//     phaseout. JSON shape:
//       {
//         "name": string,
//         "source": string,
//         "asOfYear": number,
//         "rate": number,                                // e.g. 0.07 for CA
//         "phaseoutRate": number,                         // ¢ per $ over threshold
//         "exemption":     { single, married_joint, head_household },
//         "phaseoutStart": { single, married_joint, head_household }
//       }
//
//   kind: 'piggyback_federal'  CT
//     CT minimum tax = lesser of (rateOnFederalTmt × federal TMT) or
//     (rateOnAmti × federal AMTI). No CT-specific exemption table — CT
//     piggybacks on federal AMT computation per CT-6251 lines 5-17. JSON
//     shape:
//       {
//         "kind": "piggyback_federal",
//         "name": string,
//         "source": string,
//         "asOfYear": number,
//         "rateOnFederalTmt": number,  // 0.19 for CT
//         "rateOnAmti": number          // 0.055 for CT
//       }
//
// REFRESH (annual): see ./README.md. Each state form is published on a
// different cadence; the JSON files carry an `asOfYear` so the orchestrator
// can warn if data is more than one year stale.
//
// States NOT in the registry have no individual AMT in 2026. Their
// `computeStateAmt()` call returns 0.

import CA_DATA from './CA.json';
import CO_DATA from './CO.json';
import CT_DATA from './CT.json';
import MN_DATA from './MN.json';
import {
  type AmtFilingStatus,
  tentativeMinimumTax,
} from '../federal-amt-2026';

export interface StateAmtDataSimple {
  kind?: 'simple';
  name: string;
  source: string;
  asOfYear: number;
  rate: number;
  phaseoutRate: number;
  exemption: Record<AmtFilingStatus, number>;
  phaseoutStart: Record<AmtFilingStatus, number>;
}

export interface StateAmtDataPiggyback {
  kind: 'piggyback_federal';
  name: string;
  source: string;
  asOfYear: number;
  rateOnFederalTmt: number;
  rateOnAmti: number;
}

export type StateAmtData = StateAmtDataSimple | StateAmtDataPiggyback;

export interface StateAmtLineItem {
  label: string;
  rate: number;
  amount: number;
  tax: number;
}

const REGISTRY: Record<string, StateAmtData> = {
  CA: CA_DATA as StateAmtData,
  CO: CO_DATA as StateAmtData,
  CT: CT_DATA as StateAmtData,
  MN: MN_DATA as StateAmtData,
};

export function hasStateAmt(stateCode: string): boolean {
  return stateCode.toUpperCase() in REGISTRY;
}

export function getStateAmtData(stateCode: string): StateAmtData | null {
  return REGISTRY[stateCode.toUpperCase()] ?? null;
}

function isPiggyback(data: StateAmtData): data is StateAmtDataPiggyback {
  return data.kind === 'piggyback_federal';
}

/**
 * State AMT exemption after phaseout. Returns 0 for piggyback states (CT),
 * which do not maintain a state-specific exemption table — they apply their
 * rates to the federal TMT / federal AMTI directly.
 */
export function stateAmtExemption(
  stateCode: string,
  amti: number,
  status: AmtFilingStatus,
): number {
  const data = getStateAmtData(stateCode);
  if (!data || isPiggyback(data)) return 0;
  const full = data.exemption[status];
  const start = data.phaseoutStart[status];
  const phasedOut = Math.max(0, amti - start) * data.phaseoutRate;
  return Math.max(0, full - phasedOut);
}

export function stateTentativeMinimumTax(
  stateCode: string,
  amti: number,
  status: AmtFilingStatus,
): number {
  const data = getStateAmtData(stateCode);
  if (!data) return 0;
  if (isPiggyback(data)) {
    const fedTmt = tentativeMinimumTax(amti, status);
    const onTmt = fedTmt * data.rateOnFederalTmt;
    const onAmti = amti * data.rateOnAmti;
    return Math.max(0, Math.min(onTmt, onAmti));
  }
  const exemption = stateAmtExemption(stateCode, amti, status);
  const taxableExcess = Math.max(0, amti - exemption);
  return taxableExcess * data.rate;
}

/**
 * State AMT owed. The user pays the excess of state TMT over state regular
 * tax. The caller supplies the regular state tax (ordinary income only —
 * computed elsewhere via the existing `state-tax.ts` walker).
 */
export function stateAmtOwed(
  stateCode: string,
  amti: number,
  status: AmtFilingStatus,
  regularStateTax: number,
): number {
  return Math.max(0, stateTentativeMinimumTax(stateCode, amti, status) - regularStateTax);
}

/**
 * Line items for the per-year AMT breakdown table. For simple states, returns
 * one row "{state} AMT" at the flat rate × taxable excess. For piggyback
 * states (CT), returns one row showing the binding formula (the lesser of
 * 19% × federal TMT or 5.5% × federal AMTI), labeled with which formula won.
 * Returns [] if the state's AMT is zero (or no state AMT applies).
 */
export function stateAmtLineItems(
  stateCode: string,
  amti: number,
  status: AmtFilingStatus,
): StateAmtLineItem[] {
  const data = getStateAmtData(stateCode);
  if (!data) return [];
  const code = stateCode.toUpperCase();

  if (isPiggyback(data)) {
    const fedTmt = tentativeMinimumTax(amti, status);
    const onTmt = fedTmt * data.rateOnFederalTmt;
    const onAmti = amti * data.rateOnAmti;
    const ctTax = Math.max(0, Math.min(onTmt, onAmti));
    if (ctTax <= 0) return [];
    if (onTmt <= onAmti) {
      return [{
        label: `${code} AMT (× federal TMT)`,
        rate: data.rateOnFederalTmt,
        amount: fedTmt,
        tax: onTmt,
      }];
    }
    return [{
      label: `${code} AMT (× federal AMTI cap)`,
      rate: data.rateOnAmti,
      amount: amti,
      tax: onAmti,
    }];
  }

  const exemption = stateAmtExemption(stateCode, amti, status);
  const taxableExcess = Math.max(0, amti - exemption);
  if (taxableExcess <= 0) return [];
  return [{
    label: `${code} AMT`,
    rate: data.rate,
    amount: taxableExcess,
    tax: taxableExcess * data.rate,
  }];
}
