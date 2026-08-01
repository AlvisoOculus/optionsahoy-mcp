# Local stdio MCP server for OptionsAhoy.
#
# Same eight tools as the hosted endpoint at https://optionsahoy.com/mcp,
# packaged as a runnable stdio MCP server. Use this image for MCP clients
# that only support stdio servers (Glama installer, Claude Desktop without
# mcp-remote, Cline marketplace installs, etc.). For HTTP / streamable
# clients, the canonical hosted endpoint is preferred and stays
# zero-maintenance for users.
#
# Build: docker build -t optionsahoy-mcp .
# Run:   docker run -i optionsahoy-mcp
# Then send JSON-RPC over stdin; receive responses on stdout.

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY src ./src
COPY functions ./functions
COPY lib ./lib
COPY tsconfig.json ./

ENTRYPOINT ["npx", "tsx", "src/stdio-server.ts"]
