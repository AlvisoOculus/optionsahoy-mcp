// AlphaLatitude Inc. © 2026
//
// Runs the QSBS answer contract (qsbs.contract.ts). See run-contract.ts for the
// phases. These fail red on the pre-fix formatter: caveats rendered the "does
// not appear to qualify" fallback (P2), and the per-company cap parenthetical
// fired on verdicts where the cap is not the reason gain is taxable (P9).

import { qsbsContract } from './qsbs.contract';
import { registerContractTests } from './run-contract';

registerContractTests(qsbsContract);
