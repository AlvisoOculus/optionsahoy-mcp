# Changelog

All notable changes to `optionsahoy-pydantic-ai` are documented here. This project follows semantic versioning.

## Unreleased
- Added `optionsahoy_rsu_lot_optimize`, an eighth tool: RSU lot-order divest planning (which vested lots to sell, and when, to divest a target share fraction at the lowest tax), built on the base client's `rsu_lot_order` method.

## 0.1.0
- Initial release. Seven `pydantic_ai.Tool`s for the OptionsAhoy calculators via `get_optionsahoy_tools()`, plus `optionsahoy_toolset()` and `register_optionsahoy_tools()`, built on the keyless `optionsahoy` client.
