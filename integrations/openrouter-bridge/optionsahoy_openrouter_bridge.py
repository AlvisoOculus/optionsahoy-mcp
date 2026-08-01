#!/usr/bin/env python3
# AlphaLatitude Inc. © 2026
#
# Call the OptionsAhoy MCP server from ANY model via OpenRouter.
#
# OpenRouter exposes an OpenAI-compatible /chat/completions endpoint, but it does
# NOT proxy any model provider's native or hosted MCP feature. So this recipe uses
# a client-side MCP bridge: open the remote MCP server with the reference `mcp`
# client, list its tools, hand them to the model as function-calling schemas, and
# execute the tool calls locally. The model never does the multi-year tax math; it
# selects a tool and relays the deterministic result.
#
# The OptionsAhoy MCP server is public, free, and keyless. The financial math is
# deterministic and independently verified against Internal Revenue Service
# publications and open-source tax engines: https://optionsahoy.com/verification
#
# Why it matters: frontier models overstate the after-tax outcome of the equity
# exercise schedule they propose by roughly 2x to 20x when they compute it in-context
# (benchmark + verbatim transcripts: https://optionsahoy.com/benchmark). Attaching
# the tool collapses the model's job from "do the tax math" to "call the calculator."
#
# Usage:
#   pip install -r requirements.txt
#   export OPENROUTER_API_KEY=sk-or-...
#   python optionsahoy_openrouter_bridge.py
#   OR_MODEL="anthropic/claude-3.5-sonnet" python optionsahoy_openrouter_bridge.py "your question"

import asyncio
import json
import os
import subprocess
import sys

import requests
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

MCP_URL = "https://optionsahoy.com/mcp"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# Any OpenRouter-served model with tool-calling works. Override with OR_MODEL.
MODEL = os.environ.get("OR_MODEL", "openai/gpt-4o-mini")


def openrouter_key() -> str:
    """Read the key from OPENROUTER_API_KEY, or fall back to the macOS keychain."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key
    out = subprocess.run(
        ["security", "find-generic-password", "-s", "openrouter-api-key", "-w"],
        capture_output=True, text=True,
    )
    if out.returncode == 0 and out.stdout.strip():
        return out.stdout.strip()
    sys.exit("Set OPENROUTER_API_KEY (get a key at https://openrouter.ai/keys).")


async def mcp_tools_as_functions(session):
    """List the MCP tools and convert them to OpenAI/OpenRouter function schema."""
    resp = await session.list_tools()
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": (t.description or "")[:1024],
                "parameters": t.inputSchema,
            },
        }
        for t in resp.tools
    ]


async def call_mcp_tool(session, name, args):
    """Invoke an MCP tool and return the joined text of its result."""
    result = await session.call_tool(name, args)
    return "\n".join(c.text for c in result.content if getattr(c, "type", None) == "text")


def chat(messages, tools, key):
    """One OpenRouter chat-completions turn with the MCP tools attached."""
    r = requests.post(
        OPENROUTER_URL,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Optional attribution headers OpenRouter surfaces in its dashboard.
            "HTTP-Referer": "https://optionsahoy.com/for-agents",
            "X-Title": "OptionsAhoy MCP bridge",
        },
        json={"model": MODEL, "messages": messages, "tools": tools, "tool_choice": "auto"},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]


async def run(question, key, max_rounds=6):
    """Answer `question` with the model, letting it call OptionsAhoy MCP tools."""
    async with streamablehttp_client(MCP_URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await mcp_tools_as_functions(session)
            print(f"[connected: {len(tools)} tools on {MCP_URL}]")
            messages = [{"role": "user", "content": question}]
            for _ in range(max_rounds):
                msg = chat(messages, tools, key)
                messages.append(msg)
                tool_calls = msg.get("tool_calls")
                if not tool_calls:
                    return msg.get("content", "")
                for tc in tool_calls:
                    name = tc["function"]["name"]
                    args = json.loads(tc["function"]["arguments"] or "{}")
                    print(f"\n[tool call -> {name}]\n{json.dumps(args, indent=2)}")
                    output = await call_mcp_tool(session, name, args)
                    print(f"[tool result <- {name}]\n{output[:800]}")
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "name": name,
                        "content": output,
                    })
            return "Stopped after max_rounds without a final answer."


ISO_QUESTION = (
    "I have 20,000 vested ISOs with a $2 strike and the company's current FMV is "
    "$200/share. I file married joint, my ordinary income is $300,000, and I live in "
    "California. Expected annual return on the stock is 17% with 72% volatility. "
    "Optimize a 4-year exercise schedule that maximizes after-tax net final value, and "
    "give me the shares-per-year breakdown plus the projected after-tax net final value."
)

if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else ISO_QUESTION
    print(f"[model: {MODEL}]\n[question]\n{q}\n")
    answer = asyncio.run(run(q, openrouter_key()))
    print(f"\n[final answer]\n{answer}")
