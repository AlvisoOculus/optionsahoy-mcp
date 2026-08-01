"""Scorer: did the agent reach the provable optimum?

The target is the optimum net final value (NFV), which is the maximum achievable.
A stated NFV within ``tolerance`` of it counts as correct; anything materially
higher is an impossible claim and anything materially lower leaves money on the
table. The ``overstatement_ratio`` metadata (stated / optimum) is the measure the
companion benchmark scores on: unaided models land at 1.6x to 17.6x.
"""

import re
from typing import Optional

from inspect_ai.scorer import (
    CORRECT,
    INCORRECT,
    Score,
    Target,
    accuracy,
    metric,
    scorer,
    stderr,
)

_NUM = r"([\d,]+(?:\.\d+)?)\s*([MmKk])?"


def parse_nfv(text: str) -> Optional[float]:
    """Extract the stated net final value in dollars from a model completion.

    Prefers an explicit ``ANSWER: $<number>`` line; falls back to the last dollar
    amount in the text. Understands ``M`` and ``K`` magnitude suffixes (e.g. $1.79M).
    """
    if not text:
        return None
    for pat in (r"ANSWER:\s*\$?\s*" + _NUM, r"\$\s*" + _NUM):
        matches = re.findall(pat, text)
        if matches:
            num, suffix = matches[-1]
            value = float(num.replace(",", ""))
            if suffix.lower() == "m":
                value *= 1_000_000
            elif suffix.lower() == "k":
                value *= 1_000
            return value
    return None


@metric
def mean_overstatement():
    """Mean stated/optimum ratio across scored samples (1.0 means the optimum was reached)."""

    def compute(scores) -> float:
        ratios = []
        for item in scores:
            # inspect passes SampleScore (has .score) in current versions and Score in older.
            sc = getattr(item, "score", item)
            md = getattr(sc, "metadata", None)
            if md and md.get("overstatement_ratio") is not None:
                ratios.append(md["overstatement_ratio"])
        return sum(ratios) / len(ratios) if ratios else 0.0

    return compute


@scorer(metrics=[accuracy(), stderr(), mean_overstatement()])
def optimum_match(tolerance: float = 0.02):
    """Score a completion against the provable optimum NFV within a relative tolerance."""

    async def score(state, target: Target) -> Score:
        optimum = float(target.text)
        stated = parse_nfv(state.output.completion)
        if stated is None:
            return Score(
                value=INCORRECT,
                answer="(no parseable NFV)",
                explanation="No net final value found in the model's reply.",
                metadata={"optimum": optimum},
            )
        ratio = stated / optimum if optimum else 0.0
        err = abs(stated - optimum) / optimum if optimum else 1.0
        correct = err <= tolerance
        return Score(
            value=CORRECT if correct else INCORRECT,
            answer=f"${stated:,.0f}",
            explanation=(
                f"stated ${stated:,.0f} vs provable optimum ${optimum:,.0f}; "
                f"overstatement {ratio:.2f}x; error {err * 100:.1f}%"
            ),
            metadata={
                "stated": stated,
                "optimum": optimum,
                "overstatement_ratio": ratio,
                "abs_pct_error": err,
            },
        )

    return score
