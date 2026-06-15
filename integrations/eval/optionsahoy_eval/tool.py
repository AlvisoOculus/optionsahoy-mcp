"""The OptionsAhoy optimizer exposed as an inspect_ai tool (the "tool arm").

When the eval runs with tools enabled, the model can call this to get the
deterministic optimum instead of estimating it. The tool wraps the published
keyless ``optionsahoy`` REST client; no API key is required.
"""

from typing import Optional

from inspect_ai.tool import ToolError, tool

from optionsahoy import OptionsAhoyClient, OptionsAhoyError


@tool
def amt_iso_optimizer():
    """Build the incentive-stock-option (ISO) exercise-schedule optimizer tool."""

    async def execute(
        shares: int,
        strike: float,
        fmv: float,
        filingStatus: str,
        ordinaryIncome: float,
        stateCode: str,
        horizon: int,
        cashReturnRate: float,
        grantDate: str,
        expectedGrowth: float,
        volatility: float,
        carryforwardCredit: float = 0.0,
        hasLeftCompany: bool = False,
        terminationDate: Optional[str] = None,
    ) -> str:
        """Optimize a multi-year ISO exercise schedule under the alternative minimum tax (AMT).

        Returns the exercise schedule that maximizes net final value (NFV) at the end of the
        horizon, accounting for federal and state AMT, long-term versus short-term capital
        gains, AMT credit recovery, and the time value of taxes paid early.

        Args:
            shares: Total incentive stock options (ISOs) to exercise across the horizon.
            strike: Per-share strike (exercise) price in dollars.
            fmv: Current fair market value per share in dollars.
            filingStatus: One of "single", "married_joint", "head_household".
            ordinaryIncome: Annual ordinary income in dollars.
            stateCode: Two-letter state code, e.g. "CA" or "TX".
            horizon: Planning horizon in years (1 to 10).
            cashReturnRate: Annual return on idle cash as a decimal, e.g. 0.055 for 5.5%.
            grantDate: ISO grant date in YYYY-MM-DD form.
            expectedGrowth: Expected arithmetic-mean annual return as a decimal, e.g. 0.17.
            volatility: Annualized return volatility sigma as a decimal, e.g. 0.72.
            carryforwardCredit: Prior-year AMT credit carryforward in dollars.
            hasLeftCompany: Whether the holder has left the company.
            terminationDate: Termination date in YYYY-MM-DD form if hasLeftCompany, else null.

        Returns:
            A one-line summary of the optimized schedule, its net final value, and the naive
            lump-sum and even-split baselines for comparison.
        """
        client = OptionsAhoyClient()
        try:
            res = client.amt_iso(
                shares=shares,
                strike=strike,
                fmv=fmv,
                filingStatus=filingStatus,
                ordinaryIncome=ordinaryIncome,
                stateCode=stateCode,
                carryforwardCredit=carryforwardCredit,
                horizon=horizon,
                cashReturnRate=cashReturnRate,
                grantDate=grantDate,
                hasLeftCompany=hasLeftCompany,
                terminationDate=terminationDate,
                expectedGrowth=expectedGrowth,
                volatility=volatility,
            )
        except OptionsAhoyError as exc:
            raise ToolError(str(exc)) from exc
        finally:
            client.close()

        sch = res["result"]["schedules"]
        opt, lump, even = sch["optimized"], sch["lumpSum"], sch["evenSplit"]
        years = ", ".join(f"Y{y['year']}={y['shares']:,}" for y in opt["years"])
        return (
            f"Optimized schedule: {years}. "
            f"Net final value (NFV): ${opt['nfv']:,.2f}. "
            f"Naive baselines for comparison: lump-sum ${lump['nfv']:,.2f}, "
            f"even-split ${even['nfv']:,.2f}."
        )

    return execute
