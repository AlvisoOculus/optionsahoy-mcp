# OptionsAhoy Python integrations

Python packages that let any agent framework call OptionsAhoy's keyless public
equity-compensation REST API.

- [`optionsahoy/`](./optionsahoy) — a thin, dependency-light client (httpx only)
  wrapping the calculator endpoints.
- [`optionsahoy-langchain/`](./optionsahoy-langchain) — LangChain `StructuredTool`s
  built on top of the client.
- [`llama-index-tools-optionsahoy/`](./llama-index-tools-optionsahoy) — LlamaIndex
  tools built on top of the client.
- [`crewai-optionsahoy/`](./crewai-optionsahoy) — CrewAI tools built on top of the
  client.

All four packages are published on PyPI. Install whichever you need; the adapter
packages pull in the keyless `optionsahoy` client automatically.

```bash
pip install optionsahoy                      # client only, no framework
pip install optionsahoy-langchain            # LangChain tools
pip install llama-index-tools-optionsahoy    # LlamaIndex tools
pip install crewai-optionsahoy               # CrewAI tools
```

Each package has a runnable example under its own `examples/` directory.

## Develop

For local development against your working tree, install the packages editable. The
three adapter packages depend on `optionsahoy` by version, so install `optionsahoy`
editable first so that version dependency resolves to your working tree.


```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e "./optionsahoy[dev]" \
  -e "./optionsahoy-langchain" \
  -e "./llama-index-tools-optionsahoy" \
  -e "./crewai-optionsahoy"

pytest optionsahoy/tests -m "not live"        # mocked HTTP, no network
pytest optionsahoy-langchain/tests            # mocked client, no network
pytest llama-index-tools-optionsahoy/tests    # mocked client, no network
pytest crewai-optionsahoy/tests               # mocked client, no network
OA_LIVE=1 pytest optionsahoy/tests -m live    # one live call to the real API
```

No API key is required by any package.

## Publish

These packages ship to PyPI via GitHub Actions Trusted Publishing (no stored
token). See [`PUBLISHING.md`](./PUBLISHING.md) for the one-time PyPI setup and
the release steps.
