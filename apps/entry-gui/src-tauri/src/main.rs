//! Thin Tauri shell for the installed Meshrix Entry product.
//!
//! This binary owns exactly three things:
//!   * the desktop window and its lifecycle,
//!   * the Node.js backend sidecar process (spawned at startup, killed on
//!     exit — `src-tauri/binaries/node-<triple>` bundled via `externalBin`,
//!     plus `resources/service/entry-service.mjs`),
//!   * the per-launch bridge token handed to both sides of the loopback API.
//!
//! All product logic — custody, pairing, recovery, sessions, MCP — lives in
//! the Node service (`src/main/` → bundled `entry-service.mjs`). Rust holds
//! no secrets beyond the ephemeral bearer token and performs no business
//! decisions. The token is generated per launch, passed to the service via
//! env, and delivered to the webview only through the `meshrix_bridge_config`
//! command — never placed in a URL, log line or window title.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The shell hands this to the service through env; every route demands it.
const TOKEN_ENV: &str = "MESHRIX_ENTRY_SERVICE_TOKEN";
const DATA_DIR_ENV: &str = "MESHRIX_ENTRY_DATA_DIR";
const APP_VERSION_ENV: &str = "MESHRIX_ENTRY_APP_VERSION";
const APP_EXE_ENV: &str = "MESHRIX_ENTRY_APP_EXE";
/// Dev override: path to a runnable `entry-service.mjs` when no bundled
/// resource exists (plain `node` + `npm run build:service` flow).
const SERVICE_ENTRY_ENV: &str = "MESHRIX_ENTRY_SERVICE_ENTRY";
/// Dev/ops override: explicit Node runtime path.
const NODE_ENV_VAR: &str = "MESHRIX_ENTRY_SERVICE_NODE";

enum ServiceChild {
    Sidecar(CommandChild),
    Process(std::process::Child),
}

impl ServiceChild {
    /// `CommandChild::kill` consumes its receiver — kill consumes the child too.
    fn kill(self) {
        match self {
            ServiceChild::Sidecar(child) => {
                let _ = child.kill();
            }
            ServiceChild::Process(mut child) => {
                let _ = child.kill();
            }
        }
    }
}

/// Per-launch bridge state: the bearer token plus the port slot the sidecar's
/// first stdout line fills in (0 = not yet reported), plus the child handle.
struct BridgeState {
    token: String,
    port: Arc<AtomicU16>,
    child: Mutex<Option<ServiceChild>>,
}

#[derive(Serialize)]
struct BridgeConfig {
    port: u16,
    token: String,
}

/// The webview calls this once on load to learn where the trusted service
/// listens. It waits briefly for the sidecar's first stdout line.
#[tauri::command]
async fn meshrix_bridge_config(state: tauri::State<'_, BridgeState>) -> Result<BridgeConfig, String> {
    for _ in 0..300 {
        let port = state.port.load(Ordering::Acquire);
        if port > 0 {
            return Ok(BridgeConfig {
                port,
                token: state.token.clone(),
            });
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("the entry service did not report its loopback port".to_string())
}

/// 32 bytes of CSPRNG as hex — a per-launch bearer token, never persisted.
fn mint_token() -> String {
    let bytes: [u8; 32] = rand::random();
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Parse `{"event":"entry_service_listening","port":N}` — the only stdout
/// line the service is allowed to emit in service mode.
fn parse_listening_port(line: &[u8]) -> Option<u16> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    if value.get("event")?.as_str()? != "entry_service_listening" {
        return None;
    }
    value
        .get("port")?
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0)
}

/// `service/entry-service.mjs` under the installed resource dir
/// (Contents/Resources on macOS, the install dir on Windows/Linux).
fn installed_service_entry() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join("service").join("entry-service.mjs"),
        exe_dir
            .join("..")
            .join("Resources")
            .join("service")
            .join("entry-service.mjs"),
        exe_dir
            .join("..")
            .join("resources")
            .join("service")
            .join("entry-service.mjs"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Where the runnable service bundle lives: bundled resource first, then a
/// dev checkout layout (`apps/entry-gui/dist/service/entry-service.mjs`).
fn service_entry_path() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var(SERVICE_ENTRY_ENV) {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return Some(path);
        }
    }
    installed_service_entry().or_else(|| {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dist")
            .join("service")
            .join("entry-service.mjs");
        dev.is_file().then_some(dev)
    })
}

/// The Node runtime: `MESHRIX_ENTRY_SERVICE_NODE` override → the bundled
/// sidecar (`<exe dir>/node`, where the bundler places `externalBin`) → a
/// `binaries/` subdir copy (dev staging) → `node` on PATH.
fn node_command() -> PathBuf {
    if let Ok(custom) = std::env::var(NODE_ENV_VAR) {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return path;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) { "node.exe" } else { "node" };
            for bundled in [dir.join(name), dir.join("binaries").join(name)] {
                if bundled.is_file() {
                    return bundled;
                }
            }
        }
    }
    PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
}

/// `<platform app-data>/<identifier>/entry-data` — the single product data
/// dir. The GUI sidecar gets it through `MESHRIX_ENTRY_DATA_DIR`; the
/// `--mcp-stdio` forward passes the same value, and the service's own
/// `defaultEntryDataDir()` resolves the identical path, so every entry point
/// shares custody/config/connections instead of splitting them.
fn product_data_dir(app: &tauri::App) -> PathBuf {
    app.path()
        .app_data_dir()
        .or_else(|_| {
            dirs::data_dir()
                .map(|base| base.join("com.meshrix.entry"))
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir"))
        })
        .unwrap_or_else(|_| std::env::temp_dir().join("com.meshrix.entry"))
        .join("entry-data")
}

/// Same resolution for the pre-`App` `--mcp-stdio` forward path.
fn standalone_data_dir() -> PathBuf {
    dirs::data_dir()
        .map(|base| base.join("com.meshrix.entry"))
        .unwrap_or_else(|| std::env::temp_dir().join("com.meshrix.entry"))
        .join("entry-data")
}

fn service_env_vars(data_dir: PathBuf, token: Option<&str>) -> Vec<(String, String)> {
    let mut vars = vec![
        (DATA_DIR_ENV.to_string(), data_dir.to_string_lossy().to_string()),
        (APP_VERSION_ENV.to_string(), env!("CARGO_PKG_VERSION").to_string()),
    ];
    if let Some(token) = token {
        vars.push((TOKEN_ENV.to_string(), token.to_string()));
    }
    if let Ok(exe) = std::env::current_exe() {
        vars.push((APP_EXE_ENV.to_string(), exe.to_string_lossy().to_string()));
    }
    vars
}

/// Spawn the backend sidecar via tauri-plugin-shell — `sidecar("node")`
/// resolves `<exe dir>/node`, where the bundler and `tauri dev` place the
/// `binaries/node-<triple>` externalBin. Falls back to a PATH `node` +
/// workspace service bundle when no vendored binary exists (dev without
/// `src-tauri/binaries/` populated).
fn spawn_service(
    app: &tauri::App,
    token: &str,
    port_slot: Arc<AtomicU16>,
) -> Result<ServiceChild, String> {
    let entry = service_entry_path().ok_or_else(|| {
        "entry service bundle not found (expected dist/service/entry-service.mjs or a packaged resource)"
            .to_string()
    })?;
    let envs = service_env_vars(product_data_dir(app), Some(token));
    let entry_arg = entry.to_string_lossy().to_string();

    if let Ok(command) = app.shell().sidecar("node") {
        match command.args(vec![entry_arg.clone()]).envs(envs.clone()).spawn() {
            Ok((mut rx, child)) => {
                let slot = Arc::clone(&port_slot);
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                if let Some(port) = parse_listening_port(line.as_ref()) {
                                    slot.store(port, Ordering::Release);
                                }
                            }
                            CommandEvent::Terminated(_) => break,
                            _ => {}
                        }
                    }
                });
                return Ok(ServiceChild::Sidecar(child));
            }
            Err(error) => {
                eprintln!("entry-gui shell: sidecar spawn failed ({error}); trying dev fallback");
            }
        }
    }

    // Dev fallback: a system node + the workspace-built service bundle.
    let mut command = std::process::Command::new(node_command());
    command
        .arg(&entry)
        .envs(envs)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn the entry service sidecar: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout was not piped".to_string())?;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            if let Some(port) = parse_listening_port(line.as_bytes()) {
                port_slot.store(port, Ordering::Release);
            }
        }
    });
    Ok(ServiceChild::Process(child))
}

/// `--mcp-stdio`: the app binary forwards straight onto the service — this is
/// what the emitted `mcpServers` snippet invokes. Stdio is inherited so the
/// MCP client's framed JSON-RPC reaches the service untouched.
fn run_mcp_stdio_forward() -> ! {
    let entry = service_entry_path().unwrap_or_else(|| {
        eprintln!("meshrix-entry: entry service bundle not found for --mcp-stdio");
        std::process::exit(2);
    });
    let status = std::process::Command::new(node_command())
        .arg(entry)
        .arg("--mcp-stdio")
        // Same data-dir convention as the GUI sidecar — without it the stdio
        // face reads an empty sibling dir and every call is endpoint_unreachable.
        .envs(service_env_vars(standalone_data_dir(), None))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    match status {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("meshrix-entry: could not launch the entry service ({error})");
            std::process::exit(1);
        }
    }
}

fn main() {
    if std::env::args().any(|arg| arg == "--mcp-stdio") {
        run_mcp_stdio_forward();
    }

    let token = mint_token();
    let port_slot = Arc::new(AtomicU16::new(0));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![meshrix_bridge_config])
        .setup({
            let token = token.clone();
            let port_slot = Arc::clone(&port_slot);
            move |app| {
                let slot = Arc::clone(&port_slot);
                let child = spawn_service(app, &token, slot)
                    .map_err(|message| -> Box<dyn std::error::Error> { message.into() })?;
                app.manage(BridgeState {
                    token,
                    port: port_slot,
                    child: Mutex::new(Some(child)),
                });
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Meshrix Entry shell")
        .run(|handle, event| match event {
            // Match the old shell's contract: closing the last window stops
            // the service and exits the product.
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                if handle.webview_windows().is_empty() {
                    handle.exit(0);
                }
            }
            RunEvent::Exit => {
                if let Some(state) = handle.try_state::<BridgeState>() {
                    if let Some(child) = state.child.lock().unwrap().take() {
                        child.kill();
                    }
                }
            }
            _ => {}
        });
}
