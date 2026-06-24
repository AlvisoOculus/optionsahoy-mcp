// AlphaLatitude Inc. © 2026
//
// Runs the protective-put answer contract (protective-put.contract.ts). Fails red
// on the pre-fix formatter: the engine's `recommended` pick was never surfaced
// and the holding-period straddle tax caution was missing (defect P8).

import { protectivePutContract } from './protective-put.contract';
import { registerContractTests } from './run-contract';

registerContractTests(protectivePutContract);
