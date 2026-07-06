<!-- AlphaLatitude Inc. © 2026 -->

# OptionsAhoy integrations

Drop-in ways to reach the OptionsAhoy equity-compensation calculators from whatever stack you build in. Every integration here calls the same keyless, deterministic tools behind the hosted MCP server and REST API: no OptionsAhoy account, no API key. The tools cover incentive stock option (ISO) / alternative minimum tax (AMT) scheduling, non-qualified stock option (NSO) and restricted stock unit (RSU) decisions, single-stock concentration, protective-put hedging, qualified small business stock (QSBS) qualification, and equity-funding goals.

| Integration | What it is | Path |
|---|---|---|
| Python REST client | A thin, dependency-light Python client wrapping the seven calculators behind one synchronous client. | [`python/optionsahoy`](python/optionsahoy) |
| CrewAI tools | One `crewai.tools.BaseTool` per endpoint, built on the keyless `optionsahoy` client. | [`python/crewai-optionsahoy`](python/crewai-optionsahoy) |
| Arcade toolkit | An Arcade toolkit exposing one `@tool` function per endpoint via the Arcade Tool Development Kit. | [`python/arcade-optionsahoy`](python/arcade-optionsahoy) |
| LlamaIndex tools | An `OptionsAhoyToolSpec` exposing one tool per endpoint for LlamaIndex agents. | [`python/llama-index-tools-optionsahoy`](python/llama-index-tools-optionsahoy) |
| LangChain tools | One `StructuredTool` per endpoint via `get_optionsahoy_tools`. | [`python/optionsahoy-langchain`](python/optionsahoy-langchain) |
| ACI.dev app | The OptionsAhoy app definition for the ACI.dev open-source agent-tool platform. | [`aci`](aci) |
| OpenBB Workspace agent | A FastAPI application implementing the OpenBB agent protocol, so OptionsAhoy answers planning questions inside OpenBB Workspace. Also serves the Agent2Agent (A2A) Agent Card for discovery. | [`openbb-agent`](openbb-agent) |
| Agent instruction kits | Editor rules and skills for Cursor, Windsurf, Claude Skills, and Claude Code subagents, so a coding agent calls the OptionsAhoy tools. | [`agent-kits`](agent-kits) |
| OpenRouter bridge | A recipe for attaching the keyless MCP server to any model routed through OpenRouter's OpenAI-compatible endpoint. | [`openrouter-bridge`](openrouter-bridge) |
| Coding recipes | Copy-paste Python recipes, one self-contained file per question, calling the keyless API with only `requests`. | [`recipes`](recipes) |
| Agent-builder templates | An importable n8n workflow plus build recipes for Flowise, Langflow, and Dify. | [`agent-builder-templates`](agent-builder-templates) |
| Poe server bot | OptionsAhoy as a Poe server bot, discoverable inside Poe's consumer bot marketplace. | [`poe`](poe) |
| Zed extension | A Zed editor context-server extension that connects the editor's agent to the OptionsAhoy MCP server. | [`zed`](zed) |
| Tool-use eval | An inspect_ai evaluation measuring whether an agent reaches the provable optimum on a multi-year ISO problem, with and without the tool. | [`eval`](eval) |
