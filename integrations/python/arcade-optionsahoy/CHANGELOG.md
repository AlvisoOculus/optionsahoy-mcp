# Changelog

All notable changes to `arcade-optionsahoy` are documented here. This project follows semantic versioning.

## 0.1.8

- `protective_put_price` now returns a third hedge structure, the put spread (a long put at the floor plus a short put at a solved lower strike), alongside the protective put and zero-cost collar; `spreadRiskLevel` tunes the short strike. First released here.
- Added optional `ticker` to `protective_put_price`, so a covered symbol resolves implied volatility (parity with the other tools and with openapi.json).
- Dropped the `equity_funding` `today` parameter: the endpoint ignores it by design, so it never did anything.

## 0.1.7

- Initial release. Seven Arcade tools, one per OptionsAhoy calculator endpoint, built on the keyless `optionsahoy` client and the `arcade-tdk` Tool Development Kit. Tools are discoverable through Arcade's `ToolCatalog` via `Toolkit.from_module(arcade_optionsahoy)`.
