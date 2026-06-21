## What this adds

A new public app, **OptionsAhoy** (`backend/apps/optionsahoy/`) — an equity-compensation tax/trade optimizer covering ISO/AMT exercise scheduling, NSO exercise, RSU sell-vs-hold, §1202 QSBS qualification, single-stock concentration, protective-put/collar hedging, and multi-year equity-funding plans, computed against the full federal tax code plus all 50 states + DC.

- **7 functions**, all `protocol: rest`, `no_auth`, pointing at the public production REST API at `https://optionsahoy.com/api/v1/*`.
- No credentials required — the calculators are open.

| Function | Endpoint |
|---|---|
| `OPTIONSAHOY__AMT_ISO_OPTIMIZE` | `POST /api/v1/amt-iso` |
| `OPTIONSAHOY__NSO_CALCULATE` | `POST /api/v1/nso` |
| `OPTIONSAHOY__RSU_SELL_VS_HOLD` | `POST /api/v1/rsu-sell-vs-hold` |
| `OPTIONSAHOY__CONCENTRATION_ANALYZE` | `POST /api/v1/concentration` |
| `OPTIONSAHOY__PROTECTIVE_PUT_PRICE` | `POST /api/v1/protective-put` |
| `OPTIONSAHOY__QSBS_CHECK` | `POST /api/v1/qsbs` |
| `OPTIONSAHOY__EQUITY_FUNDING_PLAN` | `POST /api/v1/equity-funding` |

## Validation

- `app.json` and all 7 functions validate against `AppUpsert` / `FunctionUpsert` (including the REST-protocol parameter validator and the Draft-7 meta-schema check), with `MAX_STRING_LENGTH = 255`.
- Every endpoint was exercised live and returns a real `200` JSON result.
- `categories: ["Financial Services"]` (matches the existing Stripe app).

## Links

- Website / agent docs: https://optionsahoy.com/for-agents
- OpenAPI: https://optionsahoy.com/openapi.json
- Source: https://github.com/AlvisoOculus/optionsahoy-mcp

Happy to adjust categories, descriptions, or move the logo SVG into `aipolabs-icons` if preferred.
