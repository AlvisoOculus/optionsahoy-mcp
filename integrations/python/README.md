# OptionsAhoy Python integrations

Python packages that let any agent framework call OptionsAhoy's keyless public
equity-compensation REST API.

- [`optionsahoy/`](./optionsahoy) — a thin, dependency-light client (httpx only)
  wrapping the calculator endpoints.
- [`langchain-optionsahoy/`](./langchain-optionsahoy) — LangChain `StructuredTool`s
  built on top of the client.
- [`llama-index-tools-optionsahoy/`](./llama-index-tools-optionsahoy) — LlamaIndex
  tools built on top of the client.
- [`crewai-optionsahoy/`](./crewai-optionsahoy) — CrewAI tools built on top of the
  client.

The three adapter packages depend on `optionsahoy` by version. Install
`optionsahoy` editable first during development (see below), and note that
`optionsahoy` must be on PyPI before end users can install the adapters.

## Develop

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e "./optionsahoy[dev]" \
  -e "./langchain-optionsahoy" \
  -e "./llama-index-tools-optionsahoy" \
  -e "./crewai-optionsahoy"

pytest optionsahoy/tests -m "not live"        # mocked HTTP, no network
pytest langchain-optionsahoy/tests            # mocked client, no network
pytest llama-index-tools-optionsahoy/tests    # mocked client, no network
pytest crewai-optionsahoy/tests               # mocked client, no network
OA_LIVE=1 pytest optionsahoy/tests -m live    # one live call to the real API
```

No API key is required by any package.

## Publish

These packages ship to PyPI via GitHub Actions Trusted Publishing (no stored
token). See [`PUBLISHING.md`](./PUBLISHING.md) for the one-time PyPI setup and
the release steps.
