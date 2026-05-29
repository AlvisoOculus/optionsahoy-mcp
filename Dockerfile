# Glama-installable wrapper around the hosted OptionsAhoy MCP endpoint.
#
# The OptionsAhoy MCP server lives at https://optionsahoy.com/mcp as a
# remote streamable-HTTP MCP server (no auth, no install, free during
# beta). Glama's directory expects locally-installable servers so it
# can introspect tools and run security checks. mcp-remote bridges
# stdio MCP (what Docker-installed clients expect) to streamable HTTP
# (what we serve), and is the canonical Anthropic-aware bridge for
# this pattern.

FROM node:20-alpine

RUN npm install -g mcp-remote@0.1.38

ENTRYPOINT ["mcp-remote", "https://optionsahoy.com/mcp"]
