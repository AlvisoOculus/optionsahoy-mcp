// AlphaLatitude Inc. © 2026
//
// Zed context-server extension for the OptionsAhoy MCP server.
//
// OptionsAhoy exposes a remote streamable-HTTP MCP server at
// https://optionsahoy.com/mcp (no auth). Zed context-server extensions launch a
// LOCAL stdio command, so this extension bridges to the remote server with the
// `mcp-remote` npm shim — the same pattern other remote MCP servers use for Zed.

use std::env;
use zed_extension_api::{self as zed, Command, ContextServerId, Project, Result};

// npm package providing the local stdio->remote bridge, and the path to its
// executable script inside the installed package.
const PACKAGE_NAME: &str = "mcp-remote";
const SERVER_PATH: &str = "node_modules/mcp-remote/dist/proxy.js";

// Remote OptionsAhoy MCP endpoint (streamable HTTP, no auth).
const REMOTE_URL: &str = "https://optionsahoy.com/mcp";

struct OptionsAhoyExtension;

impl zed::Extension for OptionsAhoyExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Command> {
        // Let Zed manage installation/updates of the `mcp-remote` bridge.
        let latest_version = zed::npm_package_latest_version(PACKAGE_NAME)?;
        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;
        if installed_version.as_deref() != Some(latest_version.as_ref()) {
            zed::npm_install_package(PACKAGE_NAME, &latest_version)?;
        }

        let node_path = zed::node_binary_path()?;
        let server_path = env::current_dir()
            .map_err(|e| e.to_string())?
            .join(SERVER_PATH)
            .to_string_lossy()
            .to_string();

        Ok(Command {
            command: node_path,
            args: vec![server_path, REMOTE_URL.into()],
            env: vec![],
        })
    }
}

zed::register_extension!(OptionsAhoyExtension);
