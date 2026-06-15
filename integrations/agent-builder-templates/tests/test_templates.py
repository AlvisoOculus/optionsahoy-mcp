"""Validate the agent-builder templates.

Offline: the n8n workflow is structurally sound (required keys, node shape,
connections resolve by name, the OptionsAhoy endpoint and method are present).
Live (OA_LIVE=1): the scenario embedded in the workflow returns a valid optimized
net final value from the keyless API.

Run from the repo root: pytest integrations/agent-builder-templates/tests
"""

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
N8N = ROOT / "n8n" / "equity-comp-tax-planner.n8n.json"
ENDPOINT = "https://optionsahoy.com/api/v1/amt-iso"


def load_n8n() -> dict:
    return json.loads(N8N.read_text())


def http_node(wf: dict) -> dict:
    return next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.httpRequest")


def set_node(wf: dict) -> dict:
    return next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.set")


def scenario_from_set(wf: dict) -> dict:
    rows = set_node(wf)["parameters"]["assignments"]["assignments"]
    return {r["name"]: r["value"] for r in rows}


# -- structure ---------------------------------------------------------------

def test_n8n_top_level():
    wf = load_n8n()
    assert isinstance(wf["nodes"], list) and wf["nodes"]
    assert isinstance(wf["connections"], dict)
    assert wf["settings"]["executionOrder"] == "v1"


def test_n8n_node_shape():
    for n in load_n8n()["nodes"]:
        for key in ("name", "type", "typeVersion", "position", "id"):
            assert key in n, f"node missing {key}: {n.get('name')}"
        assert isinstance(n["position"], list) and len(n["position"]) == 2


def test_n8n_connections_resolve_by_name():
    wf = load_n8n()
    names = {n["name"] for n in wf["nodes"]}
    for src, conn in wf["connections"].items():
        assert src in names, f"connection source not a node: {src}"
        for outputs in conn["main"]:
            for link in outputs:
                assert link["node"] in names, f"connection target missing: {link['node']}"


def test_n8n_calls_optionsahoy_endpoint():
    params = http_node(load_n8n())["parameters"]
    assert params["method"] == "POST"
    assert params["url"] == ENDPOINT
    assert params["sendBody"] is True


def test_scenario_has_required_amt_iso_fields():
    sc = scenario_from_set(load_n8n())
    for f in ("shares", "strike", "fmv", "filingStatus", "ordinaryIncome",
              "stateCode", "horizon", "cashReturnRate", "grantDate"):
        assert f in sc, f"scenario missing {f}"


def test_no_emoji_in_docs_and_template():
    for p in (ROOT / "README.md", N8N):
        text = p.read_text()
        assert "—" not in text, f"{p.name}: em-dash"
        assert not re.search(r"[\U0001F000-\U0001FAFF☀-➿]", text), f"{p.name}: emoji"


# -- live --------------------------------------------------------------------

@pytest.mark.skipif(os.environ.get("OA_LIVE") != "1", reason="set OA_LIVE=1 to run")
def test_embedded_scenario_optimizes_live():
    sc = scenario_from_set(load_n8n())
    out = subprocess.run(
        ["curl", "-s", "-X", "POST", ENDPOINT,
         "-H", "content-type: application/json", "-d", json.dumps(sc)],
        capture_output=True, text=True, timeout=40,
    ).stdout
    data = json.loads(out)
    assert data["ok"] is True
    nfv = data["result"]["schedules"]["optimized"]["nfv"]
    assert nfv > 0, f"non-positive optimized NFV: {nfv}"
