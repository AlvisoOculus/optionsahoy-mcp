// AlphaLatitude Inc. © 2026
//
// Runs the equity-funding answer contract (equity-funding.contract.ts). Fails red
// on the pre-fix formatter: an infeasible goal (recommended.plan.feasible ===
// false) was rendered as a success with the full goal as the net target and the
// "leaves the most expected wealth" framing (defect P1).

import { equityFundingContract } from './equity-funding.contract';
import { registerContractTests } from './run-contract';

registerContractTests(equityFundingContract);
