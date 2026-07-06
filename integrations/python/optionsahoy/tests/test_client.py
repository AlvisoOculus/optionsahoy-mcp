"""Mocked-transport tests for the OptionsAhoy client.

The HTTP layer is mocked with respx so each test asserts the method posts to the
correct path with the correct JSON body and parses the response, without hitting
the network.
"""

import os

import httpx
import pytest
import respx

from optionsahoy import OptionsAhoyClient, OptionsAhoyError

BASE = "https://optionsahoy.com"

# Minimal, schema-valid kwargs per endpoint. Method name -> (path, kwargs).
CASES = {
    "amt_iso": (
        "/api/v1/amt-iso",
        dict(
            shares=1000,
            strike=2.0,
            fmv=20.0,
            filingStatus="single",
            ordinaryIncome=200000,
            stateCode="CA",
            carryforwardCredit=0,
            horizon=5,
            cashReturnRate=0.04,
            grantDate="2021-01-01",
            hasLeftCompany=False,
            terminationDate=None,
        ),
    ),
    "nso": (
        "/api/v1/nso",
        dict(
            shares=1000,
            strike=2.0,
            currentPrice=20.0,
            ordinaryIncome=200000,
            filingStatus="single",
            stateCode="CA",
            stillEmployed=True,
            holdYears=2,
            holdFunding="cash",
        ),
    ),
    "rsu_sell_vs_hold": (
        "/api/v1/rsu-sell-vs-hold",
        dict(
            shares=500,
            currentPrice=50.0,
            ordinaryIncome=200000,
            filingStatus="single",
            stateCode="CA",
            stillEmployed=True,
            holdYears=1,
        ),
    ),
    "concentration": (
        "/api/v1/concentration",
        dict(
            positionValue=500000,
            costBasis=50000,
            acquisitionDate="2020-01-01",
            sector="tech_software",
            stateCode="CA",
            filingStatus="single",
            ordinaryIncome=200000,
            totalAssets=800000,
        ),
    ),
    "protective_put": (
        "/api/v1/protective-put",
        dict(
            positionValue=500000,
            sector="tech_software",
            protectionLevel=0.1,
            tenorYears=1,
        ),
    ),
    "qsbs": (
        "/api/v1/qsbs",
        dict(
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
        ),
    ),
    "equity_funding": (
        "/api/v1/equity-funding",
        dict(
            targetAfterTax=200000,
            targetDate="2027-01-01",
            ordinaryIncome=200000,
            filingStatus="single",
            stateCode="CA",
            stacks=[
                {
                    "currentPrice": 50.0,
                    "lots": [
                        {
                            "shares": 1000,
                            "costBasisPerShare": 10.0,
                            "acquisitionDate": "2021-01-01",
                        }
                    ],
                }
            ],
        ),
    ),
}


@pytest.fixture
def client():
    return OptionsAhoyClient()


@pytest.mark.parametrize("method_name", list(CASES))
@respx.mock
def test_method_posts_correct_path_and_body(client, method_name):
    path, kwargs = CASES[method_name]
    sentinel = {"ok": True, "result": {"method": method_name}}
    route = respx.post(f"{BASE}{path}").mock(
        return_value=httpx.Response(200, json=sentinel)
    )

    result = getattr(client, method_name)(**kwargs)

    assert route.called
    assert result == sentinel
    request = route.calls.last.request
    import json

    sent = json.loads(request.content)
    # Every supplied kwarg (None stripped, except terminationDate) is in the body.
    for key, value in kwargs.items():
        if value is None and key != "terminationDate":
            continue
        assert sent[key] == value


@respx.mock
def test_none_optionals_are_stripped(client):
    route = respx.post(f"{BASE}/api/v1/nso").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    client.nso(**CASES["nso"][1])
    import json

    sent = json.loads(route.calls.last.request.content)
    assert "haircut" not in sent
    assert "ticker" not in sent


@respx.mock
def test_spread_risk_level_forwarded_when_passed(client):
    route = respx.post(f"{BASE}/api/v1/protective-put").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    client.protective_put(**CASES["protective_put"][1], spreadRiskLevel=0.05)
    import json

    sent = json.loads(route.calls.last.request.content)
    assert sent["spreadRiskLevel"] == 0.05


@respx.mock
def test_spread_risk_level_omitted_when_not_passed(client):
    route = respx.post(f"{BASE}/api/v1/protective-put").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    client.protective_put(**CASES["protective_put"][1])
    import json

    sent = json.loads(route.calls.last.request.content)
    assert "spreadRiskLevel" not in sent


@respx.mock
def test_termination_date_null_is_kept(client):
    route = respx.post(f"{BASE}/api/v1/amt-iso").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    client.amt_iso(**CASES["amt_iso"][1])
    import json

    sent = json.loads(route.calls.last.request.content)
    assert "terminationDate" in sent
    assert sent["terminationDate"] is None


@respx.mock
def test_http_error_raises_optionsahoy_error(client):
    respx.post(f"{BASE}/api/v1/qsbs").mock(
        return_value=httpx.Response(400, json={"error": "bad input"})
    )
    with pytest.raises(OptionsAhoyError) as exc:
        client.qsbs(**CASES["qsbs"][1])
    assert exc.value.status_code == 400
    assert exc.value.payload == {"error": "bad input"}
    assert "bad input" in str(exc.value)


@respx.mock
def test_non_json_response_raises(client):
    respx.post(f"{BASE}/api/v1/nso").mock(
        return_value=httpx.Response(200, text="not json")
    )
    with pytest.raises(OptionsAhoyError):
        client.nso(**CASES["nso"][1])


def test_custom_base_url_strips_trailing_slash():
    c = OptionsAhoyClient(base_url="https://example.test/")
    assert c.base_url == "https://example.test"


# --- live smoke -----------------------------------------------------------


@pytest.mark.live
@pytest.mark.skipif(os.environ.get("OA_LIVE") != "1", reason="set OA_LIVE=1 to run")
def test_live_qsbs_returns_top_level_key():
    client = OptionsAhoyClient()
    result = client.qsbs(**CASES["qsbs"][1])
    assert isinstance(result, dict)
    assert "ok" in result or "result" in result, result
