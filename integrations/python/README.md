# OptionsAhoy Python integrations

Python packages that let any agent framework call OptionsAhoy's keyless public
equity-compensation REST API.

- [`optionsahoy/`](./optionsahoy) — a thin, dependency-light client (httpx only)
  wrapping the calculator endpoints.
- [`langchain-optionsahoy/`](./langchain-optionsahoy) — LangChain `StructuredTool`s
  built on top of the client.

## Develop

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e "./optionsahoy[dev]" -e "./langchain-optionsahoy"

pytest optionsahoy/tests -m "not live"     # mocked HTTP, no network
pytest langchain-optionsahoy/tests          # mocked client, no network
OA_LIVE=1 pytest optionsahoy/tests -m live   # one live call to the real API
```

No API key is required by either package.
