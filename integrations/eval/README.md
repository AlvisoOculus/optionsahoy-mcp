# OptionsAhoy agent tool-use eval

An [inspect_ai](https://inspect.aisi.org.uk/) evaluation that measures whether an
agent reaches the **provable optimum** on equity-compensation tax-optimization
questions, with and without a tool.

It turns a known failure into a runnable test. The companion benchmark
([optionsahoy.com/benchmark](https://optionsahoy.com/benchmark), updated for the
latest models, with raw transcripts at
[llm-iso-benchmark](https://github.com/AlvisoOculus/llm-iso-benchmark)) shows that
unaided frontier models, asked to optimize a multi-year incentive stock option
(ISO) exercise schedule under the alternative minimum tax (AMT), overshoot the
achievable optimum by 2x to 20x: they confidently report a net final value (NFV)
that is not achievable. This eval reproduces that as the **baseline arm**, then
gives the model the OptionsAhoy optimizer as the **tool arm** and shows it reach
the optimum exactly.

## Why this exists

An agent builder choosing whether to wire in a tool wants evidence, not a sales
pitch. This eval is that evidence: run it against your model and watch the
baseline arm overshoot while the tool arm lands on the verified optimum. The
optimum each task is scored against is the maximum achievable NFV, captured live
from the keyless OptionsAhoy API, so a stated NFV materially above it is provably
impossible.

## The two arms

| Arm | What the model gets | Expected result |
| --- | --- | --- |
| `equity_comp_iso_baseline` | The question only | Overshoots the optimum (the 2x to 20x failure) |
| `equity_comp_iso_tool` | The question plus the OptionsAhoy optimizer tool | Reaches the optimum |

Both arms see an identical prompt with every input stated. The only difference is
whether the model can call the tool.

## Scoring

The scorer `optimum_match` parses the model's stated NFV and compares it to the
provable optimum within a relative tolerance (default 2%). It reports, per sample:

- `overstatement_ratio` = stated / optimum (1.0 means the optimum was reached; the
  benchmark's headline 2x to 20x shows up here directly)
- `abs_pct_error` = how far the stated NFV is from the optimum

Aggregate metrics: `accuracy`, `stderr`, and `mean_overstatement`.

## Install

```bash
pip install inspect-ai optionsahoy
pip install -e integrations/eval        # from the repo root, editable
```

`optionsahoy` is the published keyless client; no API key is needed for the tool.
You do need a key for whichever model you evaluate (that is inspect_ai's normal
provider key, e.g. `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`).

## Run

```bash
# Baseline arm: model unaided (expect overshoot)
inspect eval optionsahoy_eval/task.py@equity_comp_iso_baseline --model openai/gpt-4o

# Tool arm: model may call the OptionsAhoy optimizer (expect optimum)
inspect eval optionsahoy_eval/task.py@equity_comp_iso_tool --model openai/gpt-4o

# View results
inspect view
```

Run both, compare `accuracy` and `mean_overstatement`. The tool arm should sit at
accuracy 1.0 and overstatement ~1.0; the baseline arm should not.

## Scenarios

Four ISO-optimization cases (one canonical plus three sensitivity variants that
move cash return, state, and volatility). Each carries a ground-truth optimum
captured live from `https://optionsahoy.com/api/v1/amt-iso` and stored in
`optionsahoy_eval/scenarios.json`. `tests/test_groundtruth.py` re-verifies the
cached optima against the live API; re-capture if a tax-table update moves them
beyond the drift tolerance.

## Tests

```bash
pip install -e "integrations/eval[dev]"
pytest integrations/eval                 # offline: parsing, scoring, task structure
OA_LIVE=1 pytest integrations/eval       # also hits the live API (drift guard + tool arm)
```

## License

MIT. Model responses referenced by the companion benchmark are reproduced there
under fair-use research-citation principles; this package contains no model
output, only the scenario definitions, the scorer, and the tool wiring.
