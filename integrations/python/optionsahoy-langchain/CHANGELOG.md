# Changelog

All notable changes to `optionsahoy-langchain` are documented here. This project follows semantic versioning.

## 0.1.8

- `amt_iso_optimize` `cashReturnRate` is now optional: the endpoint defaults it to 0.04 (a short-Treasury-like after-tax yield) when omitted, so callers need not supply it.
- `protective_put_price` now returns a third hedge structure, the put spread (a long put at the floor plus a short put at a solved lower strike), alongside the protective put and zero-cost collar; `spreadRiskLevel` tunes the short strike. First released here.
- Added optional `ticker` to `protective_put_price`, so a covered symbol resolves implied volatility (parity with the other tools and with openapi.json).
- Dropped the `equity_funding` `today` parameter: the endpoint ignores it by design, so it never did anything.

## 0.1.7

- QSBS results now include a `cappedOverageNote` when the expected gain exceeds the Section 1202 per-issuer exclusion cap: the overage is fully taxable and the note flags multi-taxpayer (non-grantor trust) stacking as an estate-planning option.



- Link the live benchmark page (https://optionsahoy.com/benchmark), updated for the latest models, in the README.

## 0.1.5
- Added a Verified section to the README: the tax math is independently cross-checked to the cent against PSL Tax-Calculator (federal) and OpenTaxSolver (state: CA, NY, NJ, PA, MA), with the proof recomputed live at https://optionsahoy.com/verification.

## 0.1.4
- Packaging and documentation polish: README status badges; full trove classifiers
  (supported Python versions, development status, audience, typing); a `py.typed` marker
  so type checkers see the package's inline type hints (PEP 561); and Issue Tracker and
  Changelog links in the project metadata.

## 0.1.3
- Rewrote the per-tool inputs/outputs reference so every field is glossed and every enum
  value is spelled out.

## 0.1.2
- Added a per-tool inputs and outputs reference to the README.

## 0.1.1
- Added the value proposition, a runnable quickstart, and absolute documentation links.

## 0.1.0
- Initial release.
