// AlphaLatitude Inc. © 2026
//
// Runs the NSO answer contract (nso.contract.ts) — chiefly P6: the disclosed
// effective sale price must equal the engine's hold.effectiveSalePrice.
//
// P11 (a missing volatility giving a sale-price ask) was investigated and found
// not reachable through the Poe flow: protective_put defaults volatility from the
// sector/ticker, and amt/concentration already route to a volatility-aware ask.
// No tool throws field "volatility" into the generic price-ask branch, so there
// is nothing to fix. See docs/agent-output-defects-2026-06-24.md.

import { nsoContract } from './nso.contract';
import { registerContractTests } from './run-contract';

registerContractTests(nsoContract);
