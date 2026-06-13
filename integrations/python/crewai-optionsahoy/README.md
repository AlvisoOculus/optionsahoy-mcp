# crewai-optionsahoy

CrewAI tools for the OptionsAhoy equity-compensation calculators. Each tool is a
`crewai.tools.BaseTool` with a pydantic `args_schema` mirroring an OptionsAhoy REST
endpoint, built on top of the keyless [`optionsahoy`](../optionsahoy) client. No
application programming interface (API) key is required.

Covered calculators: incentive stock option (ISO) / alternative minimum tax (AMT)
optimizer, non-qualified stock options (NSO), restricted stock units (RSU)
sell-versus-hold, single-stock concentration, protective put hedge pricing, qualified
small business stock (QSBS), and funding a cash goal from equity.

## Install

From this repository, install both packages editable:

```bash
pip install -e integrations/python/optionsahoy
pip install -e integrations/python/crewai-optionsahoy
```

## Usage

```python
from crewai import Agent
from crewai_optionsahoy import get_optionsahoy_tools

tools = get_optionsahoy_tools()  # one BaseTool per endpoint

# Hand to a CrewAI agent:
#   agent = Agent(role="Equity advisor", goal="...", backstory="...", tools=tools)
# or run a tool directly:
qsbs = next(t for t in tools if t.name == "optionsahoy_qsbs_check")
result = qsbs.run(
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
```

Pass your own configured client with `get_optionsahoy_tools(client=OptionsAhoyClient(...))`.
