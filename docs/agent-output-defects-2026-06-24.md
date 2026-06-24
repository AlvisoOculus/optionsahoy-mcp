# Agent-Output Defect Inventory (code-red audit, 2026-06-24)

Consolidated + deduped from four parallel auditors (Poe bot, MCP descriptions, REST/docs,
resources/prompts). Each row: severity, location, the defect, the fix, and the test phase that
locks it down (see `test-audit-plan.md`). The calc engine and tool-call JSON are correct; all of
these live in the answer/description/doc layers.

## Poe bot (`functions/poe.ts`)

| ID | Sev | Defect | Fix | Phase |
|----|-----|--------|-----|-------|
| P1 | HIGH | equity_funding shows an INFEASIBLE goal as success ("sell 1,000 shares to net $50,000,000"); never reads `rec.plan.feasible`/`shortfall`. | If `!feasible`, lead with max achievable + gap; frame schedule as "sell everything". | 0,1,2 |
| P2 | HIGH | qsbs `caveats` verdict falls to default "does not qualify", then body says "100% excluded, saving $1.19M" (self-contradiction). | Add `v==='caveats'` -> likely-qualifies-with-confirmations. | 2 |
| P3 | HIGH | rsu hardcodes "holding for the long-term rate" even when `hold.isLongTerm===false` (sub-1yr). Guard the same nso line too. | Branch on `isLongTerm`; add short-term-cliff warning. | 2 |
| P4 | MED | amt recommends exercising into an already-closed window (`windowClosed`/`daysUntilWindowClose<=0` ignored; warn only fires 0<d<400). | Add closed-window branch. | 2 |
| P5 | MED | amt large `creditRemaining` (carryforward) never shown (only when `creditRecovered>0`). | Add line when `creditRemaining>0`. | 1 |
| P6 | MED | nso/rsu disclose stated sale price ($130) but comparison uses the post-haircut effective price (~$111). | Disclose effective price. | 3 |
| P7 | MED | concentration hides `waitForLtInsight.savings` ($8,216). | Include the dollar saving. | 1 |
| P8 | MED | protective_put omits the §1092 straddle/holding-period tax caution; never surfaces `recommended`; "collar better value" line can disagree with `recommended`. | Surface `recommended`; add straddle caution. | 1,2 |
| P9 | MED | qsbs "capped at $X per company" parenthetical fires whenever `applicableCap>0`, even when the cap is not why gain is taxable (too-soon/disqualified). | Only when `taxableGain` stems from `gain>cap`. | 2 |
| P10 | LOW | equity_funding omits remainder position (`remainingShares`/value) and `comparison.optimizedSavingsVsTargetYearSale`. | Add remainder line. | 1 |
| P11 | LOW | nso missing-volatility ask says "ticker or price you expect to sell at" (wrong field). | Map volatility to a vol-specific ask. | 6 |
| P12 | LOW | amt negative lump-sum NFV renders awkwardly ("far more than ... (-$21,754)"). | Sanity phrasing for negatives. | 3 |

## MCP descriptions/schemas (`functions/_lib/mcp-tools.ts`)

| ID | Sev | Defect | Fix | Phase |
|----|-----|--------|-----|-------|
| M1 | HIGH | qsbs description verdict "(qualifies/partial/does-not-qualify)" — `does-not-qualify` never exists; omits `too-soon`,`caveats`; contradicts outputSchema enum (:664). (:1235) | Use real 5-value enum. | 4 |
| M2 | HIGH | nso description: `sharesSoldToCover`/`sharesRetained` listed under `exercise` (really `hold`); `hold` lists RSU fields `capGain*`/`isLongTerm` (real: `ltcg*`, no isLongTerm). (:932) | Rewrite to match outputSchema/NsoResult. | 4 |
| M3 | MED | concentration description over-claims `hedging (NFV + cost...)`; actual `hedging` returns only `{strike,putPrice,sigma,riskFreeRate}`. (:1075,:1143) | Drop NFV claim or implement it. | 4 |
| M4 | MED | protective_put `expectedReturn` field says "risk-neutral drift"; engine uses real-world drift (`realWorldDrift`=expectedReturn). (:1220 vs :1179,:574) | "real-world drift". | 4 |
| M5 | MED | IP leak: schemas name `lib/markets/sector-stats.ts`, `IV_OVER_RV_MULTIPLIER (1.20)`, `annualVol x 1.20`. (:1102,:1138,:1193,:1199,:1179) | Describe behavior, no internals. | 6 |
| M6 | LOW | Em-dashes in descriptions (:117,:841,:1138,:1150). | Replace. | 6 |
| M7 | NOTE | Conditionally-required fields (expectedGrowth/volatility/expectedSalePrice/expectedPositionReturn) not in `required[]`; mitigated by descriptions + could use `anyOf`. | Optional `anyOf` per field. | 4 |

## REST API + published docs

| ID | Sev | Defect | Fix | Phase |
|----|-----|--------|-----|-------|
| R1 | CRIT | for-agents protective-put curl example fabricated -> 400 (`shares/floor/horizonMonths/fundingMode` not real). (`web/app/for-agents/page.tsx:1090-1100`) | Valid body (`positionValue,sector,protectionLevel,tenorYears,ticker`). | 4 |
| R2 | CRIT | "eight statutory tests" — engine returns 6 (`entity,original-issuance,asset-cap,industry,active-business,holding`). In mcp-tools.ts:1235,:694; llms-full.txt:2409,:2618; llms.txt:16,:26; qsbs resource/prompt. | "six"; drop the 2 invented test names; regenerate docs. | 5,4 |
| R3 | CRIT | qsbs `does-not-qualify` prose in llms-full.txt:2409 (same as M1). | Align to real enum; regenerate. | 4 |
| R4 | HIGH | nso field misplacement also in llms-full (same as M2). | Regenerate from fixed descriptor. | 4 |
| R5 | HIGH | for-agents claims OpenAPI documents response schemas; the 7 POST paths `$ref` generic `CalculatorSuccess` (result = "Shape varies"). (`page.tsx:315`) | Generate real response schemas from `*_OUTPUT_SCHEMA`, or soften the claim. | 4 |
| R6 | HIGH | False "daily-refreshed option-chain"/"daily-refreshed implied-volatility surface" (engine uses a bundled table). (`page.tsx:1104`; llms-full.txt:3922) | "bundled implied-volatility table (sector-typical fallback)". | 5,6 |
| R7 | MED | llms.txt algorithm-internal disclosure: "Chunk-grid search with 1-share refinement" (:11), "Bracket-aware greedy across (year,lot) cells" (:17). | Drop strategy phrasing; keep "optimum across the candidate space". | 6 |
| R8 | MED | openapi protective-put input missing `ticker` (has only `tickerLabel`). | Add `ticker`. | 4 |
| R9 | MED | openapi equity-funding input missing the `anyOf` (stacks OR lots+currentPrice). | Add `anyOf`. | 4 |
| R10 | MED | openapi CalculatorSuccess desc: em-dash + internal path `web/lib/calc/*.ts` (:437). | Remove both. | 6 |
| R11 | LOW | Em-dashes across openapi(2)/llms.txt(15)/llms-full(6)/for-agents(10). | Replace. | 6 |
| R12 | LOW | openapi `info.version` 1.0.0 vs server 1.9.5 — decide if spec-version is intentional. | Decide + centralize. | 4 |
| R13 | LOW | llms-full.txt:22 AMT `schedules` prose under-lists fields (output-schema below it is correct). | Complete prose or defer to schema. | 4 |

## MCP resources + prompts (`mcp-resources.ts`, `mcp-prompts.ts`)

| ID | Sev | Defect | Fix | Phase |
|----|-----|--------|-----|-------|
| B1 | CRIT | qsbs resource OBBBA effective date vague; tool cutoff is 2025-07-04 (`lib/calc/qsbs.ts:24`). (:260) | State "acquired after July 4, 2025". | 5 |
| B2 | CRIT | qsbs resource tiers "partial at 3-4 years"; real 50% @3yr, 75% @4yr, 100% @5yr (`qsbs.ts:220-222`). (:268) | State the 50/75/100 tiers. | 5 |
| B3 | CRIT | nso-sell-vs-hold resource false equivalence: "15% rate spread = 15% price drop wipes savings" (conflates rate spread on the gain with a price drop on the whole position). (:90) | Remove; cite the tool's break-even sale price. | 5(manual) |
| B4 | HIGH | amt-crossover resource "28% federal" overstates; AMT is 26% or 28% by AMTI vs breakpoint. (:45) | "26% or 28% depending on AMTI". | 5 |
| B5 | HIGH | qsbs resource cap "$10M or 10x basis" omits 2027 inflation-indexing of the new $15M/$75M caps and the 50/75%-era AMT-preference vs 100% distinction (`qsbs.ts:16-18`). | Add indexing + AMT-preference notes. | 5 |
| B6 | HIGH | qsbs resource state list wrong: says CA/PA/NJ/MS/AL non-conforming; engine = CA/AL/PA/MS non-conforming, NJ conforms 2026+, HI/MA partial (`qsbs.ts:43-63`). (:281) | Align to engine. | 5 |
| B7 | HIGH | prompt analyze-nso-decision: `holdYears` optional but parser requires `>=1`; not in follow-up list. (mcp-prompts.ts:92,:103) | Surface the requirement. | 4 |
| B8 | MED | All prompts expose arg `state`, parser field is `stateCode`; `filingStatus` never an arg. NL-passthrough so not a hard break. | Rename or document the NL design. | 4 |
| B9 | MED | prompt plan-equity-funding collects top-level `shares`+`currentPrice`; parser wants `stacks[{lots}]`; `shares` arg maps to nothing. (:219) | Drop `shares` or fold into lot-gathering. | 4 |
| B10 | MED | zero-cost-collars resource + price-protective-put prompt: "Black-Scholes on a daily-refreshed implied-volatility surface" (IP + false daily claim). (resources:239; prompts:163) | "against current option-market implied volatility". | 6,5 |
| B11 | MED | concentration resource states "NVDA + QQQ ~70% correlated" as fact. (:178) | Generalize; drop the hard figure/ticker. | 6 |
| B12 | LOW | amt resource "owed by April 15" omits estimated-payment reality. (:31) | Note quarterly estimates. | 5 |
| B13 | LOW | rsu-withholding-gap omits the $1M supplemental-wage aggregation nuance. (:118) | Add note. | 5 |
| B14 | LOW | nso resource gives no 2026 Social Security wage-base figure. (:84) | Add figure. | 5 |

## Confirmed clean (do not re-audit without cause)
- Calc engine + tool-call JSON completeness (per-year, per-lot, per-test detail all present).
- MCP transport (`functions/mcp.ts`): JSON-RPC, isError handling, structuredContent + text, batch.
- All 7 REST handlers run; error handling returns clean 400s with specific field messages, no 500s.
- All embedded example calls in descriptions + llms-full execute (before the for-agents R1 fix).
- Input-schema field names + enum values match the parser for explicitly-named fields.
- No emoji, no price-source naming (Polygon/Yahoo) anywhere.
- Resource state-AMT list (CA/CO/CT/MN), Bessembinder stat, rsu 22%/37% rates, equity-funding
  framing, and prompts optimize-iso/analyze-rsu/analyze-concentration/price-protective-put/
  check-qsbs routing + enum vocab are correct.

## Resolution log

Each fix lands under a failing contract test (tests-first), then green.

- **P2** (qsbs caveats -> fallback) — FIXED, commit 700c1c6. `caveats` verdict now
  routes to the likely-qualifies line; phantom `likely`/`likely-qualifies` enums removed.
  Locked by `tests/contracts/qsbs.contract.*` (no-fallback meta-test).
- **P9** (qsbs cap parenthetical over-fires) — FIXED, commit 700c1c6. The per-company
  cap line is now gated on the engine's `cappedOverageNote` (a genuine gain-over-cap),
  not `applicableCap>0`. Locked by qsbs contract (answerRejects on partial/too-soon/
  disqualified; requiredFact on a real overage).
- **P1** (equity_funding shows an infeasible goal as success) — FIXED. The case now
  branches on `recommended.plan.feasible`: when false it leads with "your goal is more
  than this equity can net by your deadline," frames the schedule as the most that can
  be raised, and states the after-tax max + the gap (from `plan.shortfall`). The
  success "leaves the most expected wealth" framing is feasible-only. Locked by
  `tests/contracts/equity-funding.contract.*`. An existing poe.test ("cleans nested
  null stack fields") had encoded the bug — it built a 250-share -> $400k (infeasible)
  scenario and asserted the success phrase; re-pointed to assert ticker-derivation +
  a computed schedule instead.
- **P3** (rsu long-term rate on a sub-1yr hold) — FIXED (rsu). The hold wording now
  branches on `hold.isLongTerm` and adds a short-term-cliff warning. Locked by
  `tests/contracts/rsu.contract.*`.
  - NSO sub-finding: NOT a defect. NSO clamps `holdYears` to >=1 (`Math.max(1, ...)`,
    "sub-1y out of scope") and `HoldStrategy` has no `isLongTerm`, so its hold path is
    structurally always long-term. The inventory's "guard the same nso line too" was
    over-cautious; no spurious branch added. (A separate concern — that NSO silently
    clamps a sub-1yr request — belongs to Phase 6 degraded-input, not P3.)

- **P8** (protective_put: recommended never surfaced; value call could contradict it;
  no straddle caution) — FIXED. The answer now states the engine's `recommended` pick
  (protective-put / collar / none) with copy that matches it, replacing the ad-hoc
  ratio-based "collar is usually better" line that could disagree with `recommended`.
  Added the holding-period straddle caution (Section 1092). Locked by
  `tests/contracts/protective-put.contract.*` (a scenario per recommended value, each
  rejecting the other picks; straddle note required on every answer).

- **P7** (concentration hides waitForLtInsight.savings) — FIXED. When the position is
  still short-term, the wait line now states the dollar tax saved by holding to
  long-term (engine `waitForLtInsight.savings`), not just "usually worth it". Locked by
  `tests/contracts/concentration.contract.*` (waiting vs already-long-term).

- **P4** (amt recommends into an already-closed window) — FIXED. The case now detects
  `timing.windowClosed` (or daysUntilWindowClose <= 0) and leads with a "your exercise
  window has already closed" warning, marking the figures informational instead of
  presenting an actionable exercise plan. Locked by `tests/contracts/amt.contract.*`.
- **P5** (amt carryforward credit hidden) — FIXED. A line now shows
  `optimized.creditRemaining` whenever credit carries past the plan, not only when some
  was recovered in-plan. Locked by the amt contract (carryforward fact).
- **P12** (amt negative lump-sum NFV phrasing) — FIXED. A negative `lumpSum.nfv` now
  reads "exercising everything at once would actually net a loss of about $X" instead of
  "far more than ... (-$X)". Locked by a direct formatter test in amt.contract.test.ts.

- **P6** (nso/rsu disclose the stated sale price but compare on the post-haircut
  effective price) — FIXED. Both hold-vs-sell lines now disclose
  `hold.effectiveSalePrice` ("your expected price trimmed for single-stock
  volatility"). Locked by `tests/contracts/nso.contract.*` (Phase 3 reconciliation:
  the disclosed number must equal the engine's effectiveSalePrice).
- **P11** (nso missing-volatility ask names the wrong field) — NOT A DEFECT (already
  mitigated). No tool reaches the generic price-ask branch with a missing volatility:
  protective_put defaults volatility from the sector/ticker, and amt/concentration
  route to a volatility-aware ask. A defensive branch + test were prototyped, then
  removed as dead/unreachable code (the anti-fabrication guard + sector default mask
  any invalid volatility before it can throw). No change shipped.

## Auditor agent IDs (re-queryable this session)
- Poe bot: af89b010e6aa872bf
- MCP descriptions: a1a3513eabd3ed012
- REST/docs: aa9f532ad2f685df0
- Resources/prompts: af1f3298ba0a271f9
