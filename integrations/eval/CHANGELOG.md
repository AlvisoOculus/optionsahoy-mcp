# Changelog

## 0.1.0

- Initial release. inspect_ai eval `equity_comp_iso` with a baseline arm and a
  tool arm over four incentive-stock-option (ISO) optimization scenarios.
- Scorer `optimum_match` compares the model's stated net final value to the
  provable optimum and reports the overstatement ratio (stated / optimum).
- Ground truth captured live from the keyless OptionsAhoy API and drift-guarded
  by `tests/test_groundtruth.py`.
