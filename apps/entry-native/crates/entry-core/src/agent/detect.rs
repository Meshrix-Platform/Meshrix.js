//! `agent-detect.ts` — local agent discovery. One adapter per agent product
//! declares how the product manifests on this machine (PATH binaries,
//! installed desktop apps) and, when the product speaks ACP, the entrypoint
//! used to launch it as a subprocess executor. Products without an ACP
//! entrypoint are still surfaced as detected — discovery is not gated on
//! ACP support.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use futures_util::future::LocalBoxFuture;

use crate::peer::application::AcpAgentSummary;
use crate::peer::application_engine::{
    PeerApplicationAgentDirectory, PeerApplicationAgentExecutor,
};
use crate::Result;

use super::executor::AcpSubprocessExecutor;
use super::registry::{AcpAgentDefinition, AcpAgentSecretResolver, FileAcpAgentRegistry};

/// One adapter per agent product.
pub struct AgentAdapter {
    /// Stable directory-visible id, e.g. `agent.claude-code`.
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    /// Binary names probed on PATH.
    pub cli_names: &'static [&'static str],
    /// Installed desktop bundle names probed (`Claude.app` on macOS,
    /// `Claude` under Program Files on Windows).
    pub app_names: &'static [&'static str],
    /// ACP stdio entrypoint `(binary, args)` — `None` when the product has
    /// no known ACP surface; such agents remain discoverable but are not
    /// callable.
    pub acp: Option<(&'static str, &'static [&'static str])>,
    /// Adapter-private roots searched for the ACP entrypoint *instead of*
    /// the shared candidate dirs — used when the entrypoint lives inside a
    /// product-managed toolchain. Entries support `%VAR%`, `~/`, and a `*`
    /// wildcard in the final path segment.
    pub acp_dirs: &'static [&'static str],
    /// Extra env injected into the ACP subprocess (same expansion as
    /// `acp_dirs`).
    pub acp_env: &'static [(&'static str, &'static str)],
}

const ADAPTERS: &[AgentAdapter] = &[
    AgentAdapter {
        id: "agent.claude-code",
        display_name: "Claude Code",
        description: "Anthropic coding agent — bridged over claude-code-acp.",
        cli_names: &["claude"],
        app_names: &[],
        acp: Some(("claude-code-acp", &[])),
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.codex",
        display_name: "Codex",
        description: "OpenAI coding agent — bridged over codex-acp.",
        cli_names: &["codex"],
        app_names: &[],
        acp: Some(("codex-acp", &[])),
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.gemini",
        display_name: "Gemini CLI",
        description: "Google Gemini CLI — native ACP mode.",
        cli_names: &["gemini"],
        app_names: &[],
        acp: Some(("gemini", &["--acp"])),
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.copilot",
        display_name: "Copilot CLI",
        description: "GitHub Copilot CLI — native ACP server.",
        cli_names: &["copilot"],
        app_names: &[],
        acp: Some(("copilot", &["--acp", "--stdio", "--no-auto-update"])),
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.opencode",
        display_name: "OpenCode",
        description: "SST OpenCode agent — native ACP mode.",
        cli_names: &["opencode"],
        app_names: &[],
        acp: Some(("opencode", &["acp"])),
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.kimi",
        display_name: "Kimi CLI",
        description: "Moonshot Kimi CLI — native ACP mode.",
        cli_names: &["kimi"],
        app_names: &[],
        acp: Some(("kimi", &["acp"])),
        acp_dirs: &[],
        acp_env: &[],
    },
    // Hermes' Windows `hermes.exe` shim is a uv trampoline that cannot spawn
    // its interpreter headless; the managed runtime's real interpreter plus
    // PYTHONPATH over the checkout and venv site-packages is the ACP surface.
    #[cfg(windows)]
    AgentAdapter {
        id: "agent.hermes",
        display_name: "Hermes Agent",
        description: "Hermes agent — ACP adapter on its managed Python runtime.",
        cli_names: &["hermes"],
        app_names: &[],
        acp: Some(("python", &["-m", "acp_adapter"])),
        acp_dirs: &["%LOCALAPPDATA%/hermes/hermes-agent/.hermes-runtime/python/cpython-*"],
        acp_env: &[(
            "PYTHONPATH",
            "%LOCALAPPDATA%/hermes/hermes-agent;%LOCALAPPDATA%/hermes/hermes-agent/venv/Lib/site-packages",
        )],
    },
    #[cfg(not(windows))]
    AgentAdapter {
        id: "agent.hermes",
        display_name: "Hermes Agent",
        description: "Hermes agent — ACP adapter on its managed Python runtime.",
        cli_names: &["hermes"],
        app_names: &[],
        acp: Some(("python", &["-m", "acp_adapter"])),
        acp_dirs: &["~/.hermes/hermes-agent/venv/bin"],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.pi",
        display_name: "Pi",
        description: "Pi coding assistant CLI.",
        cli_names: &["pi"],
        app_names: &[],
        // `--mode rpc` is pi's own protocol, not ACP — detected only.
        acp: None,
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.droid",
        display_name: "Droid",
        description: "Factory Droid CLI — ACP via exec output mode.",
        cli_names: &["droid"],
        app_names: &[],
        acp: Some(("droid", &["exec", "-o", "acp"])),
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.cursor",
        display_name: "Cursor Agent",
        description: "Cursor agent CLI and desktop IDE.",
        cli_names: &["cursor-agent", "cursor"],
        app_names: &["Cursor"],
        acp: None,
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.goose",
        display_name: "Goose",
        description: "Block Goose agent.",
        cli_names: &["goose"],
        app_names: &["Goose"],
        acp: None,
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.aider",
        display_name: "Aider",
        description: "Aider pair-programming CLI.",
        cli_names: &["aider"],
        app_names: &[],
        acp: None,
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.claude-desktop",
        display_name: "Claude",
        description: "Anthropic Claude desktop app.",
        cli_names: &[],
        app_names: &["Claude"],
        acp: None,
        acp_dirs: &[],
        acp_env: &[],
    },
    AgentAdapter {
        id: "agent.chatgpt",
        display_name: "ChatGPT",
        description: "OpenAI ChatGPT desktop app.",
        cli_names: &[],
        app_names: &["ChatGPT"],
        acp: None,
        acp_dirs: &[],
        acp_env: &[],
    },
];

/// One adapter resolved against this machine.
pub(crate) struct DetectedAgent {
    adapter: &'static AgentAdapter,
    /// First resolved CLI binary for the adapter.
    cli: Option<PathBuf>,
    /// First resolved desktop install.
    app: Option<PathBuf>,
    /// Resolved ACP entrypoint binary — `Some` means callable over ACP.
    acp: Option<PathBuf>,
}

fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let raw = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let raw = std::env::var_os("HOME");
    raw.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// PATH plus the install roots a `.app` launch environment lacks — GUI apps
/// inherit a minimal PATH, so Homebrew and per-user toolchain bin dirs must
/// be probed explicitly.
fn candidate_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for fixed in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        dirs.push(PathBuf::from(fixed));
    }
    let home = home_dir();
    for rel in [
        ".local/bin",
        ".cargo/bin",
        ".bun/bin",
        ".deno/bin",
        ".volta/bin",
        ".asdf/shims",
        ".local/share/mise/shims",
        ".npm-global/bin",
        ".opencode/bin",
        "go/bin",
        "Library/pnpm",
    ] {
        dirs.push(home.join(rel));
    }
    #[cfg(windows)]
    {
        // npm global prefix and per-user tool dirs live outside PATH on
        // minimal service environments.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("Programs").join("cursor-agent"));
        }
    }
    // nvm keeps a bin dir per installed Node version.
    let nvm_versions = home.join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
        for entry in entries.flatten() {
            dirs.push(entry.path().join("bin"));
        }
    }
    let mut seen = HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Expand `%VAR%` markers and a leading `~/` in adapter-declared templates.
fn expand_template(tpl: &str) -> String {
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(pos) = rest.find('%') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos + 1..];
        match tail.find('%') {
            Some(end) => {
                let name = &tail[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &tail[end + 1..];
            }
            None => {
                out.push('%');
                out.push_str(tail);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    if let Some(suffix) = out.strip_prefix("~/") {
        return home_dir().join(suffix).to_string_lossy().into_owned();
    }
    out
}

/// Expand adapter-private dir templates; a `*` wildcard in the final path
/// segment lists matching entries of the parent (managed runtimes version
/// their interpreter dir).
fn expand_acp_dirs(templates: &[&'static str]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for tpl in templates {
        let path = PathBuf::from(expand_template(tpl));
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some((pre, suf)) = name.split_once('*') {
            if let Some(parent) = path.parent() {
                if let Ok(entries) = std::fs::read_dir(parent) {
                    for entry in entries.flatten() {
                        let n = entry.file_name().to_string_lossy().into_owned();
                        if n.starts_with(pre) && n.ends_with(suf) {
                            dirs.push(entry.path());
                        }
                    }
                }
            }
        } else {
            dirs.push(path);
        }
    }
    dirs
}

fn resolve_binary(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let names: Vec<String> = vec![
        format!("{name}.exe"),
        format!("{name}.cmd"),
        format!("{name}.bat"),
    ];
    #[cfg(not(windows))]
    let names: Vec<String> = vec![name.to_string()];
    for dir in dirs {
        for candidate in &names {
            let path = dir.join(candidate);
            if is_executable(&path) {
                return Some(path);
            }
        }
    }
    None
}

fn app_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![PathBuf::from("/Applications"), home_dir().join("Applications")]
    }
    #[cfg(windows)]
    {
        let mut dirs = Vec::new();
        for var in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(var) {
                dirs.push(PathBuf::from(root).join("Programs"));
            }
        }
        dirs
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Vec::new()
    }
}

fn resolve_app(name: &str) -> Option<PathBuf> {
    let want = format!("{name}.app").to_ascii_lowercase();
    for dir in app_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let matched = if cfg!(target_os = "macos") {
                file_name == want
            } else {
                file_name == name.to_ascii_lowercase()
            };
            if matched {
                return Some(entry.path());
            }
        }
    }
    None
}

/// Scan this machine for every adapter's install evidence.
pub(crate) fn scan_local_agents() -> Vec<DetectedAgent> {
    let dirs = candidate_bin_dirs();
    let mut found = Vec::new();
    for adapter in ADAPTERS {
        let cli = adapter
            .cli_names
            .iter()
            .find_map(|name| resolve_binary(&dirs, name));
        let app = adapter.app_names.iter().find_map(|name| resolve_app(name));
        let acp = adapter.acp.and_then(|(binary, _)| {
            if adapter.acp_dirs.is_empty() {
                resolve_binary(&dirs, binary)
            } else {
                // Managed-toolchain entrypoints must come from the adapter's
                // own roots — a PATH python without the adapter's env would
                // spawn an interpreter missing the product's modules.
                resolve_binary(&expand_acp_dirs(adapter.acp_dirs), binary)
            }
        });
        if cli.is_some() || app.is_some() || acp.is_some() {
            found.push(DetectedAgent {
                adapter,
                cli,
                app,
                acp,
            });
        }
    }
    found
}

fn detected_summary(agent: &DetectedAgent) -> AcpAgentSummary {
    let detected = match (agent.cli.is_some() || agent.acp.is_some(), agent.app.is_some()) {
        (true, true) => "cli+desktop",
        (true, false) => "cli",
        (false, true) => "desktop",
        (false, false) => "detected",
    };
    AcpAgentSummary {
        id: agent.adapter.id.to_string(),
        display_name: agent.adapter.display_name.to_string(),
        description: Some(agent.adapter.description.to_string()),
        enabled: true,
        detected: Some(detected.to_string()),
        transport: agent.acp.as_ref().map(|_| "acp".to_string()),
    }
}

/// Composite directory: owner-registered definitions first, then scan
/// results. A registered id shadows the matching adapter row.
pub struct DetectedAgentDirectory {
    registry: Rc<FileAcpAgentRegistry>,
    secret_resolver: Arc<dyn AcpAgentSecretResolver>,
    detected: RefCell<Vec<DetectedAgent>>,
    executors: RefCell<BTreeMap<String, Rc<AcpSubprocessExecutor>>>,
}

impl DetectedAgentDirectory {
    pub fn new(
        registry: Rc<FileAcpAgentRegistry>,
        secret_resolver: Arc<dyn AcpAgentSecretResolver>,
    ) -> Rc<Self> {
        Rc::new(Self {
            registry,
            secret_resolver,
            detected: RefCell::new(Vec::new()),
            executors: RefCell::new(BTreeMap::new()),
        })
    }

    fn refresh(&self) {
        *self.detected.borrow_mut() = scan_local_agents();
    }
}

impl PeerApplicationAgentDirectory for DetectedAgentDirectory {
    fn list(&self) -> LocalBoxFuture<'_, Result<Vec<AcpAgentSummary>>> {
        Box::pin(async move {
            self.refresh();
            let mut out = self.registry.list().await?;
            let registered: HashSet<String> = out.iter().map(|s| s.id.clone()).collect();
            let mut detected: Vec<AcpAgentSummary> = self
                .detected
                .borrow()
                .iter()
                .filter(|d| !registered.contains(d.adapter.id))
                .map(detected_summary)
                .collect();
            detected.sort_by(|a, b| a.display_name.cmp(&b.display_name));
            out.extend(detected);
            Ok(out)
        })
    }

    fn get(&self, agent_id: &str) -> Option<Rc<dyn PeerApplicationAgentExecutor>> {
        if let Some(executor) = self.registry.get(agent_id) {
            return Some(executor);
        }
        let detected = {
            self.refresh();
            self.detected
                .borrow()
                .iter()
                .find(|d| d.adapter.id == agent_id)
                .map(|d| (d.adapter, d.acp.clone()))
        };
        let (adapter, acp_path) = detected?;
        let (acp_binary, acp_args) = adapter.acp?;
        let command = acp_path
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| acp_binary.to_string());
        let mut executors = self.executors.borrow_mut();
        if let Some(executor) = executors.get(agent_id) {
            if executor.definition.command == command {
                return Some(executor.clone());
            }
        }
        let definition = AcpAgentDefinition {
            id: adapter.id.to_string(),
            display_name: adapter.display_name.to_string(),
            description: Some(adapter.description.to_string()),
            command,
            args: acp_args.iter().map(|a| a.to_string()).collect(),
            cwd: home_dir(),
            environment: adapter
                .acp_env
                .iter()
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        super::registry::AcpEnvironmentSource::Literal {
                            value: expand_template(v),
                        },
                    )
                })
                .collect(),
            permission_policy: "ask".to_string(),
            enabled: true,
        };
        let executor = Rc::new(AcpSubprocessExecutor::new(
            definition,
            self.secret_resolver.clone(),
        ));
        executors.insert(agent_id.to_string(), executor.clone());
        Some(executor)
    }
}
