// AlphaLatitude Inc. © 2026
//
// Runs the concentration answer contract (concentration.contract.ts). Fails red
// on the pre-fix formatter: a still-short-term position dropped the dollar tax
// saving from waiting for long-term treatment (waitForLtInsight.savings) and
// only said it was "usually worth it" (defect P7).

import { concentrationContract } from './concentration.contract';
import { registerContractTests } from './run-contract';

registerContractTests(concentrationContract);
