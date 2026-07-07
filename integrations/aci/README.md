<!-- AlphaLatitude Inc. © 2026 -->

# ACI.dev app submission — OptionsAhoy

This directory is the **staging copy** of the OptionsAhoy app for the open-source
[ACI.dev](https://github.com/aipotheosis-labs/aci) tool-calling platform. ACI exposes
third-party apps as LLM-callable functions; this submission registers OptionsAhoy's
seven free equity-comp calculators (the same REST endpoints behind
`https://optionsahoy.com/tools` and the MCP server) as ACI functions.

The PR copies these two files into a fork of `aipotheosis-labs/aci` at
`backend/apps/optionsahoy/`.

## Files

- `optionsahoy/app.json` — app metadata. UPPERCASE `name` (`OPTIONSAHOY`),
  `provider` AlphaLatitude Inc., `security_schemes: {"no_auth": {}}` (the API is
  unauthenticated, wide-open CORS), category `Finance`, `visibility: public`,
  `active: true`.
- `optionsahoy/functions.json` — the seven functions. Each is `protocol: "rest"`,
  `method: POST`, `server_url: https://optionsahoy.com`. Parameters follow the ACI
  convention: every object level carries `type` / `properties` / `required` /
  `visible` / `additionalProperties:false`, and POST-body params are nested under a
  top-level `body` object (mirrors `GITHUB__CREATE_ISSUE` in the ACI repo). A
  `header` group sets `Content-Type: application/json` (not LLM-visible).

| ACI function name | Endpoint |
| --- | --- |
| `OPTIONSAHOY__AMT_ISO_OPTIMIZE`     | `POST /api/v1/amt-iso` |
| `OPTIONSAHOY__NSO_CALCULATE`        | `POST /api/v1/nso` |
| `OPTIONSAHOY__RSU_SELL_VS_HOLD`     | `POST /api/v1/rsu-sell-vs-hold` |
| `OPTIONSAHOY__CONCENTRATION_ANALYZE`| `POST /api/v1/concentration` |
| `OPTIONSAHOY__PROTECTIVE_PUT_PRICE` | `POST /api/v1/protective-put` |
| `OPTIONSAHOY__QSBS_CHECK`           | `POST /api/v1/qsbs` |
| `OPTIONSAHOY__EQUITY_FUNDING_PLAN`  | `POST /api/v1/equity-funding` |

Parameter schemas and field descriptions are translated from the source-of-truth
OpenAPI spec at `optionsahoy-mcp/public/openapi.json` (cross-referenced against
`optionsahoy-mcp/functions/_lib/mcp-tools.ts`). All seven endpoints were validated
with live POST calls returning HTTP 200 JSON before this submission was prepared.

## PR steps (do NOT run until the open questions below are resolved)

1. **Fork** `aipotheosis-labs/aci` to the `AlvisoOculus` GitHub account.

   ```bash
   gh repo fork aipotheosis-labs/aci --clone --remote
   cd aci
   git checkout -b add-optionsahoy-app
   ```

2. **Copy** the staged files into the app directory:

   ```bash
   mkdir -p backend/apps/optionsahoy
   cp /Users/andrewk/Projects/optionsahoy-mcp/integrations/aci/optionsahoy/app.json       backend/apps/optionsahoy/app.json
   cp /Users/andrewk/Projects/optionsahoy-mcp/integrations/aci/optionsahoy/functions.json backend/apps/optionsahoy/functions.json
   ```

3. **Validate** (sanity-check JSON before committing):

   ```bash
   python3 -c 'import json; json.load(open("backend/apps/optionsahoy/app.json")); json.load(open("backend/apps/optionsahoy/functions.json")); print("OK")'
   ```

   If the ACI repo ships an app-validation / upsert script (check
   `backend/aci/cli` or the repo's CONTRIBUTING for `python -m aci.cli upsert-app`),
   run it to confirm the schema passes their validator.

4. **Commit and push** to the fork:

   ```bash
   git add backend/apps/optionsahoy/
   git commit -m "Add OptionsAhoy app (equity-comp tax/trade optimizer, 7 functions)"
   git push -u origin add-optionsahoy-app
   ```

5. **Open the PR** against `aipotheosis-labs/aci:main`:

   ```bash
   gh pr create --repo aipotheosis-labs/aci \
     --title "Add OptionsAhoy app: equity-comp tax/trade optimizer (7 functions)" \
     --body "Adds the OptionsAhoy app under backend/apps/optionsahoy/ with seven REST functions covering ISO/AMT exercise optimization, NSO exercise, RSU sell-vs-hold, single-stock concentration, hedge pricing (protective put, zero-cost collar, and put spread), Section 1202 QSBS qualification, and equity-funding planning. Unauthenticated public API (no_auth); server https://optionsahoy.com. Full federal tax code plus all 50 states and DC. All seven endpoints validated with live HTTP 200 calls. Parameter schemas mirror the published OpenAPI spec at https://optionsahoy.com/openapi.json."
   ```

## Open questions / operator action required

### 1. CLA signing — DECLINED (2026-07-07)

**Decision: we are NOT pursuing the ACI.dev listing.** `aipotheosis-labs/aci`
requires signing their Contributor License Agreement, which carries a rights grant
of the same class we declined for the Zed extensions registry
(zed-industries/extensions#6587, withdrawn 2026-07-01). AlphaLatitude Inc. does not
sign copyright/patent-grant CLAs to list a public, keyless integration. This app
spec (`app.json` / `functions.json`) is kept in-repo and current for reference, but
the upstream PR is not to be opened. Do not re-attempt without a reversal of that
policy by Andrew.

The remaining notes below are historical (from when this was staged for submission).

### 2. Logo: RESOLVED

`app.json` sets `logo` to `https://optionsahoy.com/favicon.svg` — the live OptionsAhoy
logo (teal circle + OA mark, square 52×52 viewBox SVG), confirmed HTTP 200. This matches
ACI's house convention of an SVG logo, so no separate icons-repo PR should be needed.

If a reviewer still prefers the SVG committed to `aipotheosis-labs/aipolabs-icons`
(`apps/optionsahoy.svg`), submit `favicon.svg` there and repoint `logo` to its raw URL.
PNG fallback if ever needed: `https://optionsahoy.com/apple-touch-icon.png` (180×180, 200).
