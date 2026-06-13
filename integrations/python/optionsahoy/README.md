# optionsahoy

A thin, dependency-light Python client for the OptionsAhoy keyless public REST API.
It wraps the equity-compensation calculators (incentive stock option (ISO) /
alternative minimum tax (AMT), non-qualified stock options (NSO), restricted stock
units (RSU), single-stock concentration, protective put hedges, qualified small
business stock (QSBS), and funding a cash goal from equity).

No API key is required, read, or sent anywhere. The only runtime dependency is
[httpx](https://www.python-httpx.org/).

## Install

```bash
pip install optionsahoy
```

Or from this repository, editable:

```bash
pip install -e integrations/python/optionsahoy
```

## Usage

```python
from optionsahoy import OptionsAhoyClient, OptionsAhoyError

client = OptionsAhoyClient()  # base_url defaults to https://optionsahoy.com

try:
    result = client.qsbs(
        acquisitionDate="2018-01-01",
        saleDate="2026-02-01",
        entityType="us-c-corp",
        acquisitionMethod="original-issuance",
        assetCategory="under-50m",
        industry="tech-software",
        activeBusiness="yes",
        adjustedBasis=10000,
        expectedGain=2000000,
        stateCode="CA",
        ordinaryIncome=250000,
        filingStatus="single",
    )
    print(result)
except OptionsAhoyError as err:
    print(err.status_code, err.payload)
```

Field names, types, and required-ness mirror the published OpenAPI schema at
<https://optionsahoy.com/openapi.json>. Optional fields left unset are not sent.

### Forward-looking inputs

Some endpoints (for example `nso` and `rsu_sell_vs_hold`) accept forward-looking
fields such as `expectedSalePrice` and `volatility` that the OpenAPI schema marks
optional. At runtime the API requires you to supply these explicitly, or to set a
covered `ticker` (for example `"NVDA"`) so the API can derive them from that
symbol's trailing data. Do not invent these values; pass what the user provides or a
ticker. Omitting both returns a clear 400 explaining which field is needed.

## Methods

- `amt_iso(...)` — multi-year ISO exercise optimizer under the AMT
- `nso(...)` — NSO exercise tax and after-tax proceeds
- `rsu_sell_vs_hold(...)` — sell-at-vest versus hold for RSUs
- `concentration(...)` — concentrated single-stock position analysis
- `protective_put(...)` — protective put hedge pricing
- `qsbs(...)` — QSBS eligibility and capital-gains exclusion
- `equity_funding(...)` — plan equity sales to fund a cash goal by a target date
