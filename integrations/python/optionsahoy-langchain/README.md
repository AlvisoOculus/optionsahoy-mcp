# optionsahoy-langchain

LangChain tools for the OptionsAhoy equity-compensation calculators. Each tool is a
`StructuredTool` with a pydantic `args_schema` mirroring an OptionsAhoy REST endpoint,
built on top of the keyless [`optionsahoy`](../optionsahoy) client. No API key is
required.

Covered calculators: incentive stock option (ISO) / alternative minimum tax (AMT)
optimizer, non-qualified stock options (NSO), restricted stock units (RSU)
sell-versus-hold, single-stock concentration, protective put hedge pricing, qualified
small business stock (QSBS), and funding a cash goal from equity.

## Install

From this repository, install both packages editable:

```bash
pip install -e integrations/python/optionsahoy
pip install -e integrations/python/optionsahoy-langchain
```

## Usage

```python
from langchain_optionsahoy import get_optionsahoy_tools

tools = get_optionsahoy_tools()  # one StructuredTool per endpoint

# Bind to any LangChain-compatible agent / model:
#   model_with_tools = model.bind_tools(tools)
# or invoke a tool directly:
qsbs = next(t for t in tools if t.name == "optionsahoy_qsbs_check")
result = qsbs.invoke({
    "acquisitionDate": "2018-01-01",
    "saleDate": "2026-02-01",
    "entityType": "us-c-corp",
    "acquisitionMethod": "original-issuance",
    "assetCategory": "under-50m",
    "industry": "tech-software",
    "activeBusiness": "yes",
    "adjustedBasis": 10000,
    "expectedGain": 2000000,
    "stateCode": "CA",
    "ordinaryIncome": 250000,
    "filingStatus": "single",
})
print(result)
```

Pass your own configured client with `get_optionsahoy_tools(client=OptionsAhoyClient(...))`.
