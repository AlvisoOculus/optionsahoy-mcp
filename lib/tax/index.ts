// AlphaLatitude Inc. © 2026

export { computeFederalGainTax, walkOrdinaryBrackets, walkLtcgFederal, computeNiit, sliceBracketsAcrossDelta } from './bracket-walker';
export type { BracketSlice } from './bracket-walker';
export { computeStateGainTax, STATES, STATE_CODES, STATE_OPTIONS, getStateBrackets } from './state-tax';
export {
  ORDINARY_2026,
  LTCG_2026,
  STANDARD_DEDUCTION_2026,
  NIIT_RATE,
  NIIT_THRESHOLDS,
  RISK_FREE_RATE_1Y,
} from './federal-2026';
export type { Bracket, Brackets, FilingStatus, StateTaxData } from './types';
