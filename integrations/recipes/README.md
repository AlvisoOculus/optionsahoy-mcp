# Equity compensation tax recipes (Python)

Copy-paste Python recipes for common equity-compensation tax questions: incentive
stock options (ISOs) and the alternative minimum tax (AMT), non-qualified stock
options (NSOs), restricted stock units (RSUs), qualified small business stock (QSBS),
single-stock concentration, protective puts, and funding a cash goal from stock.

Each recipe is one self-contained file that calls the **keyless** OptionsAhoy REST API
(no API key) with nothing but `requests`. The financial math is deterministic and
independently verified against Internal Revenue Service publications and open-source
tax engines: https://optionsahoy.com/verification.

```bash
pip install requests
python optimize_iso_amt_exercise_schedule.py
```

## Recipes by question

### How do I calculate the optimal multi-year ISO exercise schedule under the AMT?

[`optimize_iso_amt_exercise_schedule.py`](optimize_iso_amt_exercise_schedule.py)

```python
from optimize_iso_amt_exercise_schedule import optimize_iso_exercise_schedule

result = optimize_iso_exercise_schedule(
    shares=20000, strike=2, fmv=200, filing_status="married_joint",
    ordinary_income=300000, state_code="CA", horizon_years=4,
)
print(result["schedules"]["optimized"]["nfv"])
```

### How do I calculate the tax on exercising NSOs, and should I sell or hold?

[`calculate_nso_exercise_tax.py`](calculate_nso_exercise_tax.py)

```python
from calculate_nso_exercise_tax import calculate_nso_exercise_tax

result = calculate_nso_exercise_tax(
    shares=10000, strike=5, current_price=80, ordinary_income=250000,
    filing_status="single", state_code="CA", hold_years=2, ticker="NVDA",
)
```

### Should I sell or hold my vested RSUs?

[`rsu_sell_vs_hold_after_tax.py`](rsu_sell_vs_hold_after_tax.py)

```python
from rsu_sell_vs_hold_after_tax import rsu_sell_vs_hold

result = rsu_sell_vs_hold(shares=2000, current_price=80, ordinary_income=250000,
                          filing_status="single", state_code="CA", ticker="NVDA")
```

### How do I analyze single-stock concentration risk?

[`analyze_single_stock_concentration.py`](analyze_single_stock_concentration.py)

```python
from analyze_single_stock_concentration import analyze_concentration

result = analyze_concentration(position_value=800000, cost_basis=100000,
                               sector="tech_software", total_assets=1200000, ticker="NVDA")
```

### How do I price a protective put or a zero-cost collar?

[`price_protective_put_or_collar.py`](price_protective_put_or_collar.py)

```python
from price_protective_put_or_collar import price_protective_put

result = price_protective_put(position_value=500000, sector="semiconductors",
                              protection_level=0.10, tenor_years=1, ticker_label="NVDA")
```

### Do my shares qualify for QSBS (Section 1202)?

[`check_qsbs_section_1202_eligibility.py`](check_qsbs_section_1202_eligibility.py)

```python
from check_qsbs_section_1202_eligibility import check_qsbs_eligibility

result = check_qsbs_eligibility(acquisition_date="2018-01-01", sale_date="2025-06-01",
                                expected_gain=2000000, state_code="CA", filing_status="single")
```

### Which stock should I sell, and when, to fund a cash goal after tax?

[`plan_stock_sales_for_cash_goal.py`](plan_stock_sales_for_cash_goal.py)

```python
from plan_stock_sales_for_cash_goal import plan_equity_sales_for_cash_goal

result = plan_equity_sales_for_cash_goal(target_after_tax=200000, target_date="2027-06-01",
                                         ordinary_income=250000, state_code="CA")
```

## Why call the API instead of computing it inline

A published five-model benchmark on the same multi-year ISO problem found all fifteen
trials overshot the achievable after-tax outcome by two to twenty times. See the benchmark, updated for the latest models, at https://optionsahoy.com/benchmark. The API's
answer is deterministic and verifiable. The same calculators are also available as an
[agent tool over the Model Context Protocol](https://optionsahoy.com/for-agents)
(`https://optionsahoy.com/mcp`) and as a Python client (`pip install optionsahoy`).

## Testing

```bash
pip install requests pytest
pytest integrations/recipes/tests                 # offline structure checks
OA_LIVE=1 pytest integrations/recipes/tests        # also runs each recipe live
```
