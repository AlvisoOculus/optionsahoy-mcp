# llama-index-tools-optionsahoy

LlamaIndex tools for the OptionsAhoy equity-compensation calculators. `OptionsAhoyToolSpec`
exposes one tool per OptionsAhoy REST endpoint, built on top of the keyless
[`optionsahoy`](../optionsahoy) client. No application programming interface (API) key is
required.

Covered calculators: incentive stock option (ISO) / alternative minimum tax (AMT)
optimizer, non-qualified stock options (NSO), restricted stock units (RSU)
sell-versus-hold, single-stock concentration, protective put hedge pricing, qualified
small business stock (QSBS), and funding a cash goal from equity.

## Install

```bash
pip install llama-index-tools-optionsahoy
```

This pulls in the keyless `optionsahoy` client automatically.

Or from this repository, editable (for development):

```bash
pip install -e integrations/python/optionsahoy
pip install -e integrations/python/llama-index-tools-optionsahoy
```

## Usage

```python
from llama_index.tools.optionsahoy import OptionsAhoyToolSpec

spec = OptionsAhoyToolSpec()
tools = spec.to_tool_list()  # one FunctionTool per endpoint

# Hand to any LlamaIndex agent:
#   from llama_index.core.agent import ReActAgent
#   agent = ReActAgent.from_tools(tools, llm=...)
# or call a tool directly:
qsbs = next(t for t in tools if t.metadata.name == "qsbs_check")
result = qsbs.call(
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
print(result.raw_output)
```

Pass your own configured client with `OptionsAhoyToolSpec(client=OptionsAhoyClient(...))`.
