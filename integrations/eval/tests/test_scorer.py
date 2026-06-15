"""Scorer logic tests. No network, no model: pure parsing and scoring."""

import asyncio
from types import SimpleNamespace

from inspect_ai.scorer import CORRECT, INCORRECT, Target

from optionsahoy_eval.scorer import optimum_match, parse_nfv

OPTIMUM = 739600.82


def _state(completion: str) -> SimpleNamespace:
    """Minimal stand-in for an inspect TaskState (scorer only reads output.completion)."""
    return SimpleNamespace(output=SimpleNamespace(completion=completion))


def _score(completion: str, tolerance: float = 0.02):
    fn = optimum_match(tolerance=tolerance)
    return asyncio.run(fn(_state(completion), Target(str(OPTIMUM))))


# -- parse_nfv ---------------------------------------------------------------

def test_parse_answer_line():
    assert parse_nfv("blah blah\nANSWER: $739,600.82") == 739600.82


def test_parse_answer_line_no_dollar():
    assert parse_nfv("ANSWER: 739600") == 739600.0


def test_parse_magnitude_suffix():
    assert parse_nfv("My estimate is $1.79M total.") == 1_790_000.0
    assert parse_nfv("around $740K") == 740_000.0


def test_parse_prefers_answer_line_over_inline():
    text = "Year 4 tax is about $1,100,000.\nANSWER: $739,600"
    assert parse_nfv(text) == 739600.0


def test_parse_none_when_absent():
    assert parse_nfv("I recommend consulting a CPA.") is None
    assert parse_nfv("") is None


# -- scoring -----------------------------------------------------------------

def test_exact_optimum_is_correct():
    res = _score("ANSWER: $739,600.82")
    assert res.value == CORRECT
    assert abs(res.metadata["overstatement_ratio"] - 1.0) < 1e-6


def test_within_tolerance_is_correct():
    # Rounded to $740,000 is ~0.05% off: within the 2% band.
    res = _score("ANSWER: $740,000")
    assert res.value == CORRECT


def test_two_x_overshoot_is_incorrect():
    res = _score("ANSWER: $1.5M")
    assert res.value == INCORRECT
    assert res.metadata["overstatement_ratio"] > 1.9


def test_twenty_x_overshoot_is_incorrect():
    res = _score("ANSWER: $14,500,000")
    assert res.value == INCORRECT
    assert res.metadata["overstatement_ratio"] > 18


def test_suboptimal_even_split_is_incorrect():
    # The even-split baseline (~$402K) leaves money on the table: below optimum.
    res = _score("ANSWER: $402,707")
    assert res.value == INCORRECT
    assert res.metadata["abs_pct_error"] > 0.4


def test_no_answer_is_incorrect():
    res = _score("You should consult a tax professional.")
    assert res.value == INCORRECT
    assert "no parseable" in res.answer.lower()
