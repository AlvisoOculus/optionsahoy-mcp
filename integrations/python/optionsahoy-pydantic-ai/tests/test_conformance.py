# AlphaLatitude Inc. © 2026
"""Conformance guard: each tool's pydantic request schema must expose exactly the
property set public/openapi.json declares for the same REST endpoint.

openapi.json is the source of truth every adapter mirrors; this test fails when a
field is added or dropped on one surface but not the other (the drift class that
let ``haircut``, ``ticker``, and ``today`` diverge historically).
"""

import json
from pathlib import Path

from optionsahoy_pydantic_ai import get_optionsahoy_tools

# Tool name -> REST slug under /api/v1.
NAME_TO_SLUG = {
    "optionsahoy_amt_iso_optimize": "amt-iso",
    "optionsahoy_nso_calculate": "nso",
    "optionsahoy_rsu_sell_vs_hold": "rsu-sell-vs-hold",
    "optionsahoy_concentration_analyze": "concentration",
    "optionsahoy_protective_put_price": "protective-put",
    "optionsahoy_qsbs_check": "qsbs",
    "optionsahoy_equity_funding_plan": "equity-funding",
    "optionsahoy_rsu_lot_optimize": "rsu-lot-order",
}


def _openapi_props_by_slug():
    # tests -> package -> python -> integrations -> repo root
    openapi_path = Path(__file__).resolve().parents[4] / "public" / "openapi.json"
    doc = json.loads(openapi_path.read_text())
    comps = doc.get("components", {}).get("schemas", {})
    out = {}
    for path, ops in doc["paths"].items():
        post = ops.get("post")
        if not post:
            continue
        schema = post.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {})
        ref = schema.get("$ref")
        resolved = comps.get(ref.split("/")[-1], schema) if ref else schema
        out[path.split("/")[-1]] = set(resolved.get("properties", {}).keys())
    return out


def test_every_tool_schema_matches_openapi():
    by_slug = _openapi_props_by_slug()
    tools = {t.name: t for t in get_optionsahoy_tools()}
    assert set(tools) == set(NAME_TO_SLUG), "tool set drifted from the slug map"
    for name, slug in NAME_TO_SLUG.items():
        assert slug in by_slug, f"openapi.json missing /api/v1/{slug}"
        props = set(tools[name].function_schema.json_schema.get("properties", {}).keys())
        assert props == by_slug[slug], (
            f"{name} request schema diverged from openapi /api/v1/{slug}: "
            f"only-in-adapter={sorted(props - by_slug[slug])}, "
            f"only-in-openapi={sorted(by_slug[slug] - props)}"
        )
