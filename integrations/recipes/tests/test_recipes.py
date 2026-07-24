"""Validate the coding-agent recipes.

Offline: each recipe imports, exposes its function, points at the right keyless
endpoint, leads its docstring with a question (the retrieval hook), and carries no
em-dash or emoji. Live (OA_LIVE=1): each recipe's function runs against the real API
and returns a result containing the expected field.

Run from the repo root: pytest integrations/recipes/tests
"""

import importlib
import os
import re
import sys
from pathlib import Path

import pytest

RECIPES_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RECIPES_DIR))

# (module, function, endpoint path, a field the live result must contain)
RECIPES = [
    ("optimize_iso_amt_exercise_schedule", "optimize_iso_exercise_schedule", "/api/v1/amt-iso", "schedules"),
    ("calculate_nso_exercise_tax", "calculate_nso_exercise_tax", "/api/v1/nso", "exercise"),
    ("rsu_sell_vs_hold_after_tax", "rsu_sell_vs_hold", "/api/v1/rsu-sell-vs-hold", "vest"),
    ("analyze_single_stock_concentration", "analyze_concentration", "/api/v1/concentration", "concentration"),
    ("price_protective_put_or_collar", "price_protective_put", "/api/v1/protective-put", "barePut"),
    ("check_qsbs_section_1202_eligibility", "check_qsbs_eligibility", "/api/v1/qsbs", "verdict"),
    ("plan_stock_sales_for_cash_goal", "plan_equity_sales_for_cash_goal", "/api/v1/equity-funding", "recommended"),
    ("optimize_rsu_lot_order", "optimize_rsu_lot_order", "/api/v1/rsu-lot-order", "schedule"),
]

IDS = [r[0] for r in RECIPES]


@pytest.mark.parametrize("module,func,endpoint,_key", RECIPES, ids=IDS)
def test_recipe_imports_and_exposes_function(module, func, endpoint, _key):
    mod = importlib.import_module(module)
    assert callable(getattr(mod, func)), f"{module}.{func} missing"
    assert mod.API_URL == f"https://optionsahoy.com{endpoint}"


@pytest.mark.parametrize("module,func,endpoint,_key", RECIPES, ids=IDS)
def test_recipe_docstring_leads_with_a_question(module, func, endpoint, _key):
    mod = importlib.import_module(module)
    first_line = (mod.__doc__ or "").strip().splitlines()[0]
    assert "?" in first_line, f"{module} docstring should lead with a question"


def test_no_emoji_or_emdash_in_recipes():
    for path in list(RECIPES_DIR.glob("*.py")) + [RECIPES_DIR / "README.md"]:
        text = path.read_text()
        assert "—" not in text, f"{path.name}: em-dash"
        assert not re.search(r"[\U0001F000-\U0001FAFF☀-➿]", text), f"{path.name}: emoji"


def test_readme_links_every_recipe():
    readme = (RECIPES_DIR / "README.md").read_text()
    for module, _func, _endpoint, _key in RECIPES:
        assert f"{module}.py" in readme, f"README does not link {module}.py"


@pytest.mark.skipif(os.environ.get("OA_LIVE") != "1", reason="set OA_LIVE=1 to run")
@pytest.mark.parametrize("module,func,endpoint,key", RECIPES, ids=IDS)
def test_recipe_runs_against_live_api(module, func, endpoint, key):
    mod = importlib.import_module(module)
    result = getattr(mod, func)()
    assert isinstance(result, dict)
    assert key in result, f"{module}: live result missing '{key}' (got {list(result)[:8]})"
