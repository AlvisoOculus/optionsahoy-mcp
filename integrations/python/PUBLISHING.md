# Publishing the OptionsAhoy Python integrations to PyPI

These four packages publish to PyPI via GitHub Actions Trusted Publishing. No
long-lived PyPI API token is stored in this repo or in GitHub secrets. PyPI
trusts a short-lived OIDC token that GitHub mints for this exact repo, workflow,
and environment.

Packages and their PyPI project names:

| Directory                       | PyPI project name               |
| ------------------------------- | ------------------------------- |
| `optionsahoy/`                  | `optionsahoy`                   |
| `optionsahoy-langchain/`        | `optionsahoy-langchain`         |
| `llama-index-tools-optionsahoy/`| `llama-index-tools-optionsahoy` |
| `crewai-optionsahoy/`           | `crewai-optionsahoy`            |

The three adapter packages depend on `optionsahoy` by version
(`optionsahoy>=0.1.0`), so `optionsahoy` must be published first (or at least be
on PyPI) before the adapters can be installed by end users.

## One-time PyPI setup (operator)

Do this once per project name, before the first release. Until it is done, the
publish job fails with an authentication error.

1. Sign in at https://pypi.org.

2. For each of the four project names above, register a GitHub Actions trusted
   publisher:
   - If the project does not exist on PyPI yet, create a **pending publisher** at
     https://pypi.org/manage/account/publishing/ . The first successful workflow
     run creates the project automatically.
   - If the project already exists, open its
     **Manage project -> Settings -> Publishing -> Add a new publisher**.

3. Enter these exact values for every project:

   | Field            | Value                |
   | ---------------- | -------------------- |
   | Owner            | `AlvisoOculus`       |
   | Repository name  | `optionsahoy-mcp`    |
   | Workflow name    | `publish-python.yml` |
   | Environment name | (leave blank)        |

   Leave Environment blank. The workflow binds no GitHub environment, and the two
   sides must match exactly.

4. (Optional, for a manual-approval gate) If you later want each publish to wait
   for a one-click human approval: create a GitHub Actions environment named `pypi`
   (repo **Settings -> Environments -> New environment**, add yourself as a required
   reviewer), add `environment: pypi` back to the job in
   `.github/workflows/publish-python.yml`, AND set Environment `pypi` on each PyPI
   publisher. All three must agree.

## Cutting a release

1. Bump `version` in the `pyproject.toml` of each package you intend to ship.
   PyPI permanently rejects re-uploading a version that already exists, so a new
   version is required to publish a package. Ship `optionsahoy` first if its
   public API changed.

2. Commit and push to `main`.

3. Cut a GitHub Release (Releases -> Draft a new release -> choose a tag, e.g.
   `python-v0.1.0`, then Publish). Publishing the release triggers
   `publish-python.yml`, which builds and uploads all four packages. Packages
   whose version already exists on PyPI are rejected by PyPI and do not block the
   others (the matrix uses `fail-fast: false`).

4. To publish a single package without a release, run the workflow manually:
   Actions -> **Publish Python integrations to PyPI** -> Run workflow, and pick
   the package from the dropdown.

## Local build check (no upload)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install build
for d in optionsahoy optionsahoy-langchain llama-index-tools-optionsahoy crewai-optionsahoy; do
  python -m build "$d"
done
```

Each build produces a wheel and an sdist under `<package>/dist/`. This does not
upload anything.
