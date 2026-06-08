# Security Policy

## Reporting a vulnerability

Email **security@optionsahoy.com** with details and steps to reproduce. Please do
not open a public issue for security reports, and please allow a reasonable window
to fix before any public disclosure. We aim to acknowledge reports within three
business days.

This matches the disclosure contact published at
<https://optionsahoy.com/.well-known/security.txt>.

## Scope

- The hosted MCP server at `https://optionsahoy.com/mcp`
- The REST API under `https://optionsahoy.com/api/v1/`
- The code in this repository

## Data and privacy posture

By design there is very little for an attacker to reach:

- **No accounts, no authentication, no stored user data.** The tools take inputs,
  compute a result, and return it.
- **Inputs are not retained.** The financial figures passed to a tool are used for
  the computation and are not stored. Usage telemetry records only coarse metadata
  (which tool, success or error, client name, country), never the financial figures
  you enter.
- **Deterministic, offline computation.** Tool math runs from compiled tax tables
  with no third-party calls at compute time.

## Not a security issue

Questions about a calculation result or an unexpected number are not security
reports. See "Reporting a calculation bug or unexpected output" in the README, or
open a GitHub issue.
