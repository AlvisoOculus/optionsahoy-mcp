"""Validate the agent instruction kits.

These are markdown/JSON instruction artifacts, not executable code, so "testing"
means: frontmatter parses, the tool names referenced are exactly the eight the
live OptionsAhoy server exposes (no typos, no stale names), descriptions stay
within each host's documented limit, and every MCP endpoint is the canonical URL.

Run from the repo root: pytest integrations/agent-kits
"""

import json
import re
from pathlib import Path

import yaml

KIT = Path(__file__).resolve().parent.parent
ENDPOINT = "https://optionsahoy.com/mcp"

# The eight tools the live server exposes (tools/list). Any tool token in an
# artifact must be in this set; the routing tables must reference all eight.
TOOLS = {
    "amt_iso_optimize",
    "nso_calculate",
    "rsu_sell_vs_hold",
    "concentration_analyze",
    "protective_put_price",
    "qsbs_check",
    "equity_funding_plan",
    "rsu_lot_optimize",
}

CURSOR_RULE = KIT / "cursor/.cursor/rules/equity-comp-tax.mdc"
WINDSURF_RULE = KIT / "windsurf/.windsurf/rules/equity-comp-tax.md"
SKILL = KIT / "claude-skill/equity-comp-tax/SKILL.md"
SUBAGENT = KIT / "claude-code-subagent/.claude/agents/equity-comp-tax.md"

CURSOR_MCP = KIT / "cursor/.cursor/mcp.json"
WINDSURF_MCP = KIT / "windsurf/mcp_config.json"

INSTRUCTION_FILES = [CURSOR_RULE, WINDSURF_RULE, SKILL, SUBAGENT]


def split_frontmatter(path: Path):
    text = path.read_text()
    assert text.startswith("---\n"), f"{path.name}: frontmatter must start on line 1"
    _, fm, body = text.split("---\n", 2)
    return yaml.safe_load(fm), body


def referenced_tools(text: str) -> set:
    return {t for t in TOOLS if re.search(rf"\b{re.escape(t)}\b", text)}


# -- existence ---------------------------------------------------------------

def test_all_artifacts_exist():
    for p in INSTRUCTION_FILES + [CURSOR_MCP, WINDSURF_MCP]:
        assert p.is_file(), f"missing: {p}"


# -- frontmatter parses + required fields ------------------------------------

def test_cursor_frontmatter():
    fm, _ = split_frontmatter(CURSOR_RULE)
    assert isinstance(fm["description"], str) and fm["description"]
    assert fm["alwaysApply"] is False
    # Agent Requested type must NOT set globs (that would make it auto-attached).
    assert "globs" not in fm


def test_windsurf_frontmatter():
    fm, _ = split_frontmatter(WINDSURF_RULE)
    assert fm["trigger"] in {"always_on", "manual", "model_decision", "glob"}
    assert fm["trigger"] == "model_decision"
    assert isinstance(fm["description"], str) and fm["description"]


def test_skill_frontmatter():
    fm, _ = split_frontmatter(SKILL)
    assert re.fullmatch(r"[a-z0-9-]{1,64}", fm["name"]), "skill name: lowercase/hyphen, <=64"
    # Agent Skills standard caps description at 1024 chars.
    assert len(fm["description"]) <= 1024, f"description {len(fm['description'])} > 1024"
    assert fm["description"]
    assert fm.get("allowed-tools") == "mcp__optionsahoy__*"


def test_subagent_frontmatter():
    fm, _ = split_frontmatter(SUBAGENT)
    assert re.fullmatch(r"[a-z0-9-]+", fm["name"])
    assert fm["description"]
    servers = fm["mcpServers"]
    assert isinstance(servers, list) and len(servers) == 1
    inner = servers[0]["optionsahoy"]
    assert inner["type"] == "http"
    assert inner["url"] == ENDPOINT


# -- tool-name correctness ---------------------------------------------------

def test_every_artifact_references_only_real_tools():
    for p in INSTRUCTION_FILES:
        text = p.read_text()
        bogus = re.findall(r"`([a-z_]+_(?:optimize|calculate|hold|analyze|price|check|plan))`", text)
        for name in bogus:
            assert name in TOOLS, f"{p.name}: references unknown tool `{name}`"


def test_routing_tables_cover_all_eight_tools():
    # The three rich artifacts route the full tool set; the subagent lists them too.
    for p in (CURSOR_RULE, WINDSURF_RULE, SKILL, SUBAGENT):
        found = referenced_tools(p.read_text())
        assert found == TOOLS, f"{p.name}: missing {TOOLS - found}"


# -- MCP endpoint correctness ------------------------------------------------

def test_cursor_mcp_config():
    cfg = json.loads(CURSOR_MCP.read_text())
    assert cfg["mcpServers"]["optionsahoy"]["url"] == ENDPOINT


def test_windsurf_mcp_config():
    cfg = json.loads(WINDSURF_MCP.read_text())
    # Windsurf uses serverUrl (not url) for remote servers.
    assert cfg["mcpServers"]["optionsahoy"]["serverUrl"] == ENDPOINT


def test_no_emdash_or_emoji_in_artifacts():
    # House voice rules: no em-dashes, no emoji.
    for p in INSTRUCTION_FILES + [KIT / "README.md"]:
        text = p.read_text()
        assert "—" not in text, f"{p.name}: contains an em-dash"
        assert not re.search(r"[\U0001F000-\U0001FAFF☀-➿]", text), f"{p.name}: emoji"
