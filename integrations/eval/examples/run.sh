#!/usr/bin/env bash
# Run both arms of the OptionsAhoy tool-use eval and compare.
#
# Requires: pip install inspect-ai optionsahoy && pip install -e integrations/eval
# Requires: a provider key for the model under test, e.g. OPENAI_API_KEY.
set -euo pipefail

MODEL="${1:-openai/gpt-4o}"

echo "Baseline arm (model unaided) on $MODEL"
inspect eval optionsahoy_eval/task.py@equity_comp_iso_baseline --model "$MODEL"

echo "Tool arm (OptionsAhoy optimizer available) on $MODEL"
inspect eval optionsahoy_eval/task.py@equity_comp_iso_tool --model "$MODEL"

echo "Open the result viewer with: inspect view"
