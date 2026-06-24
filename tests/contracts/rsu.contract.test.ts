// AlphaLatitude Inc. © 2026
//
// Runs the RSU answer contract (rsu.contract.ts). Fails red on the pre-fix
// formatter: a sub-1-year hold (hold.isLongTerm === false) was still described
// as "holding the shares for the long-term rate" (defect P3).

import { rsuContract } from './rsu.contract';
import { registerContractTests } from './run-contract';

registerContractTests(rsuContract);
