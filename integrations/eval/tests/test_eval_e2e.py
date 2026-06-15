"""End-to-end pipeline test using inspect's built-in mock model.

No provider key and no network: the mockllm model returns canned completions, so
this exercises the full dataset -> solver -> model -> scorer -> metrics path
offline. A real model evaluation needs a provider key (see README).
"""

from inspect_ai import eval as inspect_eval
from inspect_ai.model import ModelOutput, get_model

from optionsahoy_eval.task import equity_comp_iso_baseline


def _run(reply: str, tmp_path):
    model = get_model(
        "mockllm/model",
        custom_outputs=[ModelOutput.from_content("mockllm/model", reply)] * 4,
    )
    logs = inspect_eval(
        equity_comp_iso_baseline(),
        model=model,
        display="none",
        log_dir=str(tmp_path),
    )
    return logs[0]


def _metrics(log) -> dict:
    score = log.results.scores[0]
    return {name: m.value for name, m in score.metrics.items()}


def test_pipeline_runs_and_scores_all_samples(tmp_path):
    log = _run("No idea, consult a CPA.", tmp_path)
    assert log.status == "success"
    assert len(log.samples) == 4
    m = _metrics(log)
    assert {"accuracy", "stderr", "mean_overstatement"} <= set(m)


def test_overshoot_arm_scores_zero(tmp_path):
    # A wildly-high claim is above every scenario's provable optimum -> all incorrect.
    log = _run("This schedule nets you a fortune.\nANSWER: $50,000,000", tmp_path)
    m = _metrics(log)
    assert m["accuracy"] == 0.0
    assert m["mean_overstatement"] > 20  # 50M / ~0.7M-2M optima
