//! Meshrix Entry — native CLI + ratatui TUI on `entry-core`.
//!
//! Commands mirror the TS `apps/entry` surface: account login, pairing
//! (challenge + browser step-up + completion), forward sessions, operation
//! queries, recovery bootstrap, MCP stdio bridge and a live TUI dashboard.

use std::io::Write as _;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context};
use clap::{Parser, Subcommand};
use meshrix_entry_core::custody::CustodyPreference;
use meshrix_entry_core::endpoint::runtime::{
    PersonalEndpointStepUpRequest, PersonalEndpointStepUpResult, StepUpDriver,
};
use meshrix_entry_core::mcp::{serve_entry_mcp_stdio, EntryMcpBridge};
use meshrix_entry_core::service::{EntryService, FileCustodyOpts, ServiceConfig, StepUpPoll};
use serde_json::{json, Value};

#[derive(Parser)]
#[command(name = "meshrix-entry", version, about = "Meshrix Entry client — native binary")]
struct Cli {
    /// Data directory for config + file custody (default: platform config dir).
    #[arg(long, global = true, env = "MESHRIX_ENTRY_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Bare HTTPS origin of the account service.
    #[arg(long, global = true, env = "MESHRIX_ACCOUNT_ORIGIN")]
    account_origin: Option<String>,
    /// Cloudflare Access service-token client id for a gated account origin.
    #[arg(long, global = true, env = "MESHRIX_ACCOUNT_ACCESS_ID")]
    account_access_id: Option<String>,
    /// Cloudflare Access service-token client secret for a gated account origin.
    #[arg(long, global = true, env = "MESHRIX_ACCOUNT_ACCESS_SECRET")]
    account_access_secret: Option<String>,
    /// Default relay service base (wss://…) for endpoints this device hosts.
    #[arg(long, global = true, env = "MESHRIX_RELAY_SERVICE")]
    relay_service: Option<String>,
    /// Custody backend: auto | macos | windows | file.
    #[arg(long, global = true, env = "MESHRIX_CUSTODY", default_value = "auto")]
    custody: String,
    /// 64-hex wrap secret for `file` custody (required when custody=file).
    #[arg(long, global = true, env = "MESHRIX_CUSTODY_SECRET")]
    custody_secret: Option<String>,
    /// Allow literal `ws://` loopback relays (fixtures only).
    #[arg(long, global = true)]
    allow_insecure_loopback: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the redacted service state as JSON.
    Status,
    /// Begin account sign-in: opens a browser URL and polls to completion.
    Login {
        /// Only print the browser URL and transaction id; do not poll.
        #[arg(long)]
        no_wait: bool,
    },
    /// Poll a previously created login transaction.
    LoginPoll {
        transaction_id: String,
        verifier: String,
    },
    /// Approve a pending XXXX-XXXX device code (login or step-up) using this
    /// device's signed session — headless approval for remote machines.
    Approve {
        /// The code shown by the requesting device (`XXXX-XXXX`).
        code: String,
    },
    /// Pair a new endpoint from an invite (full flow: challenge → browser
    /// step-up → completion). Requires a signed-in account.
    Pair {
        /// Invite text (base32 payload or `meshrix://pair/...` URL).
        invite: String,
        /// Only print the step-up browser URL; complete later with `pair-complete`.
        #[arg(long)]
        no_wait: bool,
    },
    /// List enrolled connections.
    Connections,
    /// Connect and stream session events until Ctrl+C.
    Connect { connection_id: String },
    /// One-shot JSON-RPC request on a connection.
    Request {
        connection_id: String,
        /// JSON-RPC message payload (e.g. '{"method":"tools/list"}').
        message: String,
    },
    /// Query the endpoint operation ledger.
    QueryOp {
        connection_id: String,
        operation_id: String,
    },
    /// Close a connection's live session.
    Disconnect { connection_id: String },
    /// Run the recovery bootstrap for a connection.
    Recover {
        connection_id: String,
        /// Recovery text (base32 groups).
        recovery_text: String,
    },
    /// Serve MCP over newline-delimited stdio for a connection.
    McpStdio {
        connection_id: String,
        /// server_info JSON for initialize replies.
        #[arg(long)]
        server_info: Option<String>,
        /// capabilities JSON for initialize replies.
        #[arg(long)]
        capabilities: Option<String>,
    },
    /// Serve the agent-facing MCP tool surface over stdio: paired devices as
    /// destinations, remote agent discovery and durable task submission —
    /// the same contract the desktop `--mcp-stdio` owner bridge exposes.
    Mcp,
    /// List local ACP agents hosted on this device.
    Agents,
    /// Register a local ACP agent (subprocess, executed under "ask" policy).
    AgentAdd {
        /// Display name.
        name: String,
        /// Executable path or name.
        command: String,
        /// Argument for the command (repeatable).
        #[arg(long = "arg")]
        args: Vec<String>,
        /// Working directory (default: current dir).
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// Environment: NAME=VALUE (host env passthrough) or
        /// NAME=@custody-ref (secret resolved from custody at launch).
        #[arg(long = "env")]
        environment: Vec<String>,
    },
    /// Update a local agent definition (same fields as agent-add).
    AgentUpdate {
        id: String,
        name: String,
        command: String,
        #[arg(long = "arg")]
        args: Vec<String>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long = "env")]
        environment: Vec<String>,
    },
    /// Remove a local agent definition.
    AgentRemove { id: String },
    /// Fetch the remote agent catalog for a connection.
    RemoteAgents { connection_id: String },
    /// Trigger a live remote agent scan for a connection (the catalog
    /// request); prints the completed discovery record.
    RemoteDiscover { connection_id: String },
    /// Submit a prompt to a remote agent and stream progress to a terminal
    /// state (the primary ACP conversation path).
    Chat {
        connection_id: String,
        /// Remote agent id (from `remote-agents`).
        agent: String,
        /// Prompt text.
        prompt: String,
        /// Remote model selector as `model[effort]` (e.g.
        /// `gpt-6.1-sol[low]`); bare model ids leave the effort untouched.
        #[arg(long)]
        model: Option<String>,
        /// Print the operation id and exit without waiting for completion.
        #[arg(long)]
        no_wait: bool,
        /// Optional caller-side agent id recorded on the operation.
        #[arg(long)]
        caller_agent: Option<String>,
    },
    /// List durable application operations.
    Ops,
    /// Show one operation record as JSON.
    Op { operation_id: String },
    /// Cancel an in-flight operation (propagates to the receiver).
    OpCancel { operation_id: String },
    /// Page the local peer inbox for a connection.
    Inbox {
        connection_id: String,
        #[arg(long, default_value_t = 64)]
        limit: usize,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Print the out-of-band Signal safety evidence for a wire peer.
    Safety {
        connection_id: String,
        peer_device_id: String,
    },
    /// Sign out of the local account session (custody credential dropped).
    SignOut,
    /// Close a connection locally; `--remote` also revokes the device grant
    /// at the account authority.
    Revoke {
        connection_id: String,
        #[arg(long)]
        remote: bool,
    },
    /// Print the MCP stdio `mcpServers` snippet; `--write` also writes the
    /// app-owned managed config under the data dir.
    McpConfig {
        #[arg(long)]
        write: bool,
    },
    /// Resolve a pending permission request on an operation.
    Permit {
        operation_id: String,
        permission_id: String,
        /// Select an option id from the permission request.
        #[arg(long)]
        option: Option<String>,
        /// Refuse the requested permission.
        #[arg(long)]
        deny: bool,
    },
    /// Manage the personal endpoint runtime — this device acting as the
    /// relay-side endpoint that paired entry clients connect into.
    Endpoint {
        #[command(subcommand)]
        command: EndpointCommand,
    },
    /// Recovery key lifecycle: setup, reveal-once, confirmation, snapshot
    /// publication and rotation for this install.
    Recovery {
        #[command(subcommand)]
        command: RecoveryCommand,
    },
    /// Endpoint access grants: catalog and grant_access requests on an
    /// account-bound connection.
    Grant {
        #[command(subcommand)]
        command: GrantCommand,
    },
    /// Live ratatui dashboard.
    Tui,
}

#[derive(Subcommand)]
enum GrantCommand {
    /// List the scopes this endpoint can grant.
    Catalog { connection_id: String },
    /// Request a new access grant (opens browser step-up approval).
    Request {
        connection_id: String,
        /// Endpoint scope names to request.
        scopes: Vec<String>,
    },
}

#[derive(Subcommand)]
enum RecoveryCommand {
    /// Print the redacted recovery view as JSON.
    Status,
    /// Stage a fresh recovery key behind the one-shot reveal window.
    Begin,
    /// Reveal the pending recovery text exactly once.
    Reveal,
    /// Confirm the revealed key was saved — custody-stores the derived
    /// material and starts writer registration or snapshot publication.
    Confirm,
    /// Stage a rotation of the active recovery key.
    Rotate,
    /// Publish the current configuration snapshot to the recovery vault.
    Publish,
    /// Resume a persisted account vault-writer registration.
    RetryWriter,
    /// Poll the in-flight writer step-up transaction to completion.
    PollWriter,
    /// Re-deliver rotation-begin to endpoints that have not acknowledged.
    RetryRotation,
    /// Abort the in-flight rotation; endpoints keep the incumbent key.
    AbortRotation,
    /// Fresh-install import: recovery text alone enrolls this device.
    /// Requires an endpoint-issued recovery-access credential (JSON file
    /// from the endpoint operator tooling).
    Import {
        /// The `mrk1…` recovery text.
        recovery_text: String,
        /// Relay/vault service base URL (defaults to the stored default).
        #[arg(long)]
        service_url: Option<String>,
        /// JSON file holding the endpoint-issued recovery access credential.
        #[arg(long)]
        access: Option<std::path::PathBuf>,
    },
}

#[derive(Subcommand)]
enum EndpointCommand {
    /// Claim the account-owned personal route and enroll this device as the
    /// endpoint (browser step-up approval required in-flow).
    Enroll,
    /// Re-claim the route after a revocation under the original account.
    Reenroll,
    /// Start the endpoint runtime: relay session, peer bundle publication,
    /// and application-route registration.
    Start {
        /// Keep the process alive serving inbound work until Ctrl+C
        /// (headless endpoint hosting).
        #[arg(long)]
        wait: bool,
        /// Once the relay session is admitted, mint a pairing invite and
        /// write its JSON to this path.
        #[arg(long)]
        invite_file: Option<PathBuf>,
    },
    /// Stop the endpoint runtime.
    Stop,
    /// Print the endpoint snapshot as JSON.
    Status,
    /// Mint a pairing invite for a new entry device.
    Invite,
    /// List paired entry devices still authorized under the account.
    Devices,
    /// Send a plaintext payload to a paired entry device.
    Send {
        peer_device_id: String,
        /// UTF-8 plaintext payload.
        message: String,
        #[arg(long)]
        message_id: Option<String>,
    },
}

fn data_dir(cli: &Cli) -> PathBuf {
    cli.data_dir.clone().unwrap_or_else(|| {
        directories::ProjectDirs::from("ai", "meshrix", "entry")
            .map(|d| d.config_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from(".meshrix-entry"))
    })
}

fn open_service(cli: &Cli) -> anyhow::Result<EntryService> {
    let custody = match cli.custody.as_str() {
        "auto" => CustodyPreference::Auto,
        "os" => CustodyPreference::Os,
        "file" => CustodyPreference::File,
        other => bail!("unknown custody backend '{other}' (auto|os|file)"),
    };
    let file_custody = if custody == CustodyPreference::File {
        let secret = cli
            .custody_secret
            .as_deref()
            .context("--custody-secret (or MESHRIX_CUSTODY_SECRET) is required for file custody")?;
        let bytes = hex_decode(secret).context("custody secret must be 64 hex chars")?;
        let wrap_secret: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("custody secret must be exactly 32 bytes (64 hex)"))?;
        Some(FileCustodyOpts {
            data_dir: data_dir(cli).join("custody"),
            wrap_secret,
        })
    } else {
        None
    };
    let account_access = match (&cli.account_access_id, &cli.account_access_secret) {
        (Some(client_id), Some(client_secret)) => Some(meshrix_entry_core::account::AccessServiceToken {
            client_id: client_id.clone(),
            client_secret: client_secret.clone(),
        }),
        (None, None) => None,
        _ => anyhow::bail!("--account-access-id and --account-access-secret must be set together"),
    };
    let config = ServiceConfig {
        account_origin: cli.account_origin.clone(),
        account_access,
        default_relay_service: cli.relay_service.clone(),
        allow_insecure_loopback: cli.allow_insecure_loopback,
        custody,
        file_custody,
        ..ServiceConfig::default()
    };
    Ok(EntryService::open(data_dir(cli), config)?)
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn print_json(value: &Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap());
}

async fn poll_login(service: &EntryService, transaction_id: &str, verifier: &str) -> anyhow::Result<()> {
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        match service.poll_account_login(transaction_id, verifier)?.as_str() {
            "complete" => {
                println!("signed in");
                return Ok(());
            }
            "expired" | "consumed" => bail!("account transaction expired; start again"),
            _ => {}
        }
    }
    bail!("timed out waiting for browser sign-in")
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();

    match &cli.command {
        Command::Tui => return tui::run(open_service(&cli)?).await,
        _ => {}
    }

    let service = open_service(&cli)?;
    match &cli.command {
        Command::Status => {
            print_json(&meshrix_entry_core::service::redacted_state_json(&service.state()));
        }
        Command::Login { no_wait } => {
            let tx = service.begin_account_login()?;
            print_json(&json!({
                "browserUrl": tx.browser_url,
                "userCode": tx.user_code,
                "transactionId": tx.transaction_id,
                "verifier": tx.verifier,
            }));
            if !no_wait {
                poll_login(&service, &tx.transaction_id, &tx.verifier).await?;
            }
        }
        Command::LoginPoll { transaction_id, verifier } => {
            let state = service.poll_account_login(transaction_id, verifier)?;
            println!("{state}");
        }
        Command::Approve { code } => {
            service.approve_device_code(code)?;
            println!("approved");
        }
        Command::Pair { invite, no_wait } => {
            let mut flow = service.begin_pairing(invite).await?;
            let challenge_id = service.pairing_challenge(&mut flow).await?;
            println!("challenge issued: {challenge_id}");
            let tx = service.begin_pairing_step_up(&flow)?;
            print_json(&json!({
                "stepUpBrowserUrl": tx.browser_url,
                "userCode": tx.user_code,
                "transactionId": tx.transaction_id,
            }));
            if *no_wait {
                println!("(pairing cannot be resumed from another process — rerun `pair` to start over)");
                return Ok(());
            }
            let mut completed = None;
            for _ in 0..150 {
                tokio::time::sleep(Duration::from_secs(2)).await;
                match service.poll_pairing_step_up(&flow, &tx)? {
                    StepUpPoll::Pending => {}
                    StepUpPoll::Expired | StepUpPoll::Consumed => {
                        bail!("step-up approval expired; start pairing again")
                    }
                    StepUpPoll::Complete { account, permit_id, target } => {
                        completed = Some((account, permit_id, target));
                        break;
                    }
                }
            }
            let Some((account, permit_id, target)) = completed else {
                bail!("timed out waiting for step-up approval")
            };
            let connection = service
                .complete_pairing(&mut flow, &account, &permit_id, &target)
                .await?;
            print_json(&json!({
                "enrolled": true,
                "connection": meshrix_entry_core::service::redacted_state_json(&service.state())
                    .get("connections").cloned().unwrap_or(Value::Null),
                "connectionId": connection.connection_id,
            }));
        }
        Command::Connections => {
            let state = service.state();
            print_json(&json!({ "connections": state.connections }));
        }
        Command::Connect { connection_id } => {
            let session = service.connect(connection_id).await?;
            print_json(&session_view(&session));
            let mut events = session.events();
            loop {
                tokio::select! {
                    changed = events.changed() => {
                        if changed.is_err() { break; }
                        println!("{:?}", &*events.borrow());
                    }
                    _ = tokio::signal::ctrl_c() => break,
                }
            }
        }
        Command::Request { connection_id, message } => {
            let msg: Value = serde_json::from_str(message).context("message must be JSON")?;
            let result = service.request(connection_id, msg).await?;
            print_json(&result);
        }
        Command::QueryOp { connection_id, operation_id } => {
            let result = service.query_operation(connection_id, operation_id).await?;
            print_json(&result);
        }
        Command::Disconnect { connection_id } => {
            service.disconnect(connection_id).await;
            println!("disconnected");
        }
        Command::Recover { connection_id, recovery_text } => {
            let outcome = service.recover_connection(connection_id, recovery_text).await?;
            println!("{outcome}");
        }
        Command::McpStdio { connection_id, server_info, capabilities } => {
            let session = service.connect(connection_id).await?;
            let info = server_info
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .context("server-info must be JSON")?;
            let caps = capabilities
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .context("capabilities must be JSON")?;
            let bridge = EntryMcpBridge::new(session, info, caps);
            let stdin = tokio::io::stdin();
            let mut stdout = tokio::io::stdout();
            serve_entry_mcp_stdio(stdin, &mut stdout, move |msg| {
                let bridge = bridge.clone();
                async move { bridge.handle(&msg).await }
            })
            .await?;
        }
        Command::Mcp => {
            let service = std::sync::Arc::new(service);
            let stdin = tokio::io::stdin();
            let mut stdout = tokio::io::stdout();
            serve_entry_mcp_stdio(stdin, &mut stdout, move |msg| {
                let service = service.clone();
                async move { agent_mcp::handle(&service, &msg).await }
            })
            .await?;
        }
        Command::Agents => {
            print_json(&json!({ "agents": service.local_agents().await? }));
        }
        Command::AgentAdd { name, command, args, cwd, environment } => {
            let summary = service
                .agent_register(agent_input(None, name, command, args, cwd, environment)?)
                .await?;
            print_json(&serde_json::to_value(&summary)?);
        }
        Command::AgentUpdate { id, name, command, args, cwd, environment } => {
            let summary = service
                .agent_update(id, agent_input(Some(id.clone()), name, command, args, cwd, environment)?)
                .await?;
            print_json(&serde_json::to_value(&summary)?);
        }
        Command::AgentRemove { id } => {
            let removed = service.agent_remove(id).await?;
            print_json(&json!({ "removed": removed }));
        }
        Command::RemoteAgents { connection_id } => {
            service.connect(connection_id).await?;
            let agents = service.remote_agents(connection_id).await?;
            print_json(&json!({ "agents": agents }));
        }
        Command::RemoteDiscover { connection_id } => {
            service.connect(connection_id).await?;
            let mut events = service.peer_events()?;
            let record = service
                .application_discover(connection_id, None)
                .await?;
            if record.status == "completed" {
                print_json(&serde_json::to_value(&record)?);
                return Ok(());
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
            loop {
                tokio::select! {
                    event = events.recv() => {
                        match event {
                            Ok(meshrix_entry_core::peer::PeerHostEvent::ApplicationDiscovery(updated))
                                if updated.request_id == record.request_id =>
                            {
                                if updated.status == "completed" || updated.status == "failed" {
                                    print_json(&serde_json::to_value(&updated)?);
                                    return Ok(());
                                }
                            }
                            Ok(_) => {}
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                bail!("peer host stopped")
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        bail!("discovery did not complete within 120s")
                    }
                }
            }
        }
        Command::Chat { connection_id, agent, prompt, model, no_wait, caller_agent } => {
            // Ensure the session is live before submitting — admission opens
            // the peer lane the operation rides on.
            service.connect(connection_id).await?;
            let mut events = service.peer_events()?;
            let record = service
                .application_submit(
                    connection_id,
                    None,
                    caller_agent.clone(),
                    agent,
                    prompt,
                    model.clone(),
                )
                .await?;
            print_json(&serde_json::to_value(&record)?);
            if *no_wait {
                return Ok(());
            }
            watch_operation(&service, &mut events, &record.operation_id).await?;
        }
        Command::Ops => {
            print_json(&json!({ "operations": service.application_operations().await? }));
        }
        Command::Op { operation_id } => {
            match service.application_operation(operation_id).await? {
                Some(record) => print_json(&serde_json::to_value(&record)?),
                None => bail!("operation {operation_id} not found"),
            }
        }
        Command::OpCancel { operation_id } => {
            let record = service.application_cancel(operation_id).await?;
            print_json(&serde_json::to_value(&record)?);
        }
        Command::Inbox { connection_id, limit, after } => {
            let result = service.peer_inbox(connection_id, *limit, *after).await?;
            print_json(&serde_json::to_value(&result)?);
        }
        Command::Safety { connection_id, peer_device_id } => {
            let result = service.peer_pair_safety(connection_id, peer_device_id).await?;
            print_json(&serde_json::to_value(&result)?);
        }
        Command::SignOut => {
            service.sign_out()?;
            println!("signed out");
        }
        Command::Revoke { connection_id, remote } => {
            service.revoke_connection(connection_id, *remote).await?;
            println!("{}", if *remote { "revoked" } else { "disconnected" });
        }
        Command::McpConfig { write } => {
            let result = if *write {
                service.write_mcp_config()?
            } else {
                service.mcp_snippet()
            };
            print_json(&result);
        }
        Command::Permit { operation_id, permission_id, option, deny } => {
            let resolution = if *deny {
                meshrix_entry_core::peer::AcpPermissionResolution::Cancelled
            } else {
                let option = option.clone().context("--option <id> selects a permission option (or pass --deny)")?;
                meshrix_entry_core::peer::AcpPermissionResolution::Selected { option_id: option }
            };
            let record = service
                .application_resolve_permission(operation_id, permission_id, resolution)
                .await?;
            print_json(&serde_json::to_value(&record)?);
        }
        Command::Endpoint { command } => match command {
            EndpointCommand::Enroll => {
                let service = std::sync::Arc::new(service);
                let snapshot = service
                    .endpoint_enroll(endpoint_step_up_driver(service.clone()))
                    .await?;
                print_json(&serde_json::to_value(&snapshot)?);
            }
            EndpointCommand::Reenroll => {
                let service = std::sync::Arc::new(service);
                let snapshot = service
                    .endpoint_reenroll(endpoint_step_up_driver(service.clone()))
                    .await?;
                print_json(&serde_json::to_value(&snapshot)?);
            }
            EndpointCommand::Start { wait, invite_file } => {
                let snapshot = service.endpoint_start().await?;
                print_json(&serde_json::to_value(&snapshot)?);
                if let Some(path) = invite_file {
                    // Invites require an admitted relay session + published
                    // peer bundle — poll the snapshot until the runtime is
                    // accepting work, then mint and persist the invite.
                    for _ in 0..60 {
                        let snap = service.endpoint_snapshot().await?;
                        if snap.accepts_new_work {
                            let invite = service.endpoint_invite().await?;
                            let text = serde_json::to_string_pretty(&invite)?;
                            std::fs::write(path, format!("{text}\n"))?;
                            println!("invite written: {}", path.display());
                            break;
                        }
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
                if *wait {
                    tokio::signal::ctrl_c().await?;
                }
            }
            EndpointCommand::Stop => {
                service.endpoint_stop().await?;
                println!("stopped");
            }
            EndpointCommand::Status => {
                let snapshot = service.endpoint_snapshot().await?;
                print_json(&serde_json::to_value(&snapshot)?);
            }
            EndpointCommand::Invite => {
                let invite = service.endpoint_invite().await?;
                print_json(&serde_json::to_value(&invite)?);
            }
            EndpointCommand::Devices => {
                let devices = service.endpoint_peer_status().await?;
                print_json(&json!({ "devices": devices }));
            }
            EndpointCommand::Send { peer_device_id, message, message_id } => {
                let entry = service
                    .endpoint_peer_send(peer_device_id, message.as_bytes(), message_id.clone())
                    .await?;
                print_json(&serde_json::to_value(&entry)?);
            }
        },
        Command::Recovery { command } => match command {
            RecoveryCommand::Status => {
                print_json(&service.recovery_view());
            }
            RecoveryCommand::Begin => {
                print_json(&service.begin_recovery_setup()?);
            }
            RecoveryCommand::Reveal => {
                print_json(&service.reveal_recovery_key()?);
            }
            RecoveryCommand::Confirm => {
                print_json(&service.confirm_recovery_saved().await?);
            }
            RecoveryCommand::Rotate => {
                print_json(&service.begin_recovery_rotation().await?);
            }
            RecoveryCommand::Publish => {
                print_json(&service.publish_snapshot().await?);
            }
            RecoveryCommand::RetryWriter => {
                print_json(&service.retry_vault_writer_registration().await?);
            }
            RecoveryCommand::PollWriter => {
                for _ in 0..150 {
                    match service.poll_vault_writer_step_up().await? {
                        meshrix_entry_core::service::VaultWriterStepUpPoll::Idle => {
                            println!("no pending writer registration");
                            break;
                        }
                        meshrix_entry_core::service::VaultWriterStepUpPoll::Pending { browser_url, user_code } => {
                            println!("approve the vault writer registration in your browser (code {user_code}):\n{browser_url}");
                        }
                        meshrix_entry_core::service::VaultWriterStepUpPoll::Expired => {
                            bail!("the writer authorization expired; retry registration");
                        }
                        meshrix_entry_core::service::VaultWriterStepUpPoll::Consumed => {
                            bail!("the writer authorization was consumed without completing");
                        }
                        meshrix_entry_core::service::VaultWriterStepUpPoll::Complete => {
                            print_json(&service.recovery_view());
                            break;
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
            RecoveryCommand::RetryRotation => {
                print_json(&service.retry_rotation_delivery().await?);
            }
            RecoveryCommand::AbortRotation => {
                print_json(&service.abort_rotation()?);
            }
            RecoveryCommand::Import { recovery_text, service_url, access } => {
                struct FileAccess {
                    body: serde_json::Value,
                }
                impl meshrix_entry_core::recovery::service::RecoveryAccessPort for FileAccess {
                    fn provision(
                        &self,
                        _vault_id: &str,
                    ) -> std::pin::Pin<
                        Box<
                            dyn std::future::Future<
                                    Output = meshrix_entry_core::Result<
                                        meshrix_entry_core::recovery::service::RecoveryAccessOutcome,
                                    >,
                                > + Send
                                + '_,
                        >,
                    > {
                        let body = self.body.clone();
                        Box::pin(async move {
                            let get = |k: &str| body.get(k).and_then(|v| v.as_str());
                            if body.get("outcome").and_then(|v| v.as_str()) == Some("refused") {
                                return Ok(meshrix_entry_core::recovery::service::RecoveryAccessOutcome::Refused {
                                    refusal: get("refusal").unwrap_or("refused").to_string(),
                                });
                            }
                            Ok(meshrix_entry_core::recovery::service::RecoveryAccessOutcome::Issued {
                                device_id: get("deviceId").unwrap_or_default().to_string(),
                                relay_credential: get("relayCredential").unwrap_or_default().to_string(),
                                tenant_id: get("tenantId").unwrap_or_default().to_string(),
                                route_id: get("routeId").unwrap_or_default().to_string(),
                                admission_generation: body
                                    .get("admissionGeneration").and_then(|v| v.as_u64()).unwrap_or(0),
                                revocation_revision: body
                                    .get("revocationRevision").and_then(|v| v.as_u64()).unwrap_or(0),
                            })
                        })
                    }
                }
                let provisioner = match &access {
                    Some(path) => {
                        let body: serde_json::Value =
                            serde_json::from_str(&std::fs::read_to_string(path)?)?;
                        Some(FileAccess { body })
                    }
                    None => None,
                };
                let outcome = service
                    .import_recovery_text(&recovery_text, service_url.as_deref(), provisioner.as_ref().map(|p| -> &dyn meshrix_entry_core::recovery::service::RecoveryAccessPort { p }))
                    .await?;
                print_json(&serde_json::json!({
                    "phase": match &outcome {
                        meshrix_entry_core::service::RecoveryImportPhase::Enrolled { .. } => "enrolled",
                        meshrix_entry_core::service::RecoveryImportPhase::Refused { .. } => "refused",
                        meshrix_entry_core::service::RecoveryImportPhase::SnapshotMissing => "snapshot_missing",
                        meshrix_entry_core::service::RecoveryImportPhase::SnapshotUnusable { .. } => "snapshot_unusable",
                    },
                    "outcome": match &outcome {
                        meshrix_entry_core::service::RecoveryImportPhase::Enrolled { connection_id, vault_id, key_id, generation } =>
                            serde_json::json!({"connectionId": connection_id, "vaultId": vault_id, "keyId": key_id, "generation": generation}),
                        meshrix_entry_core::service::RecoveryImportPhase::Refused { refusal } =>
                            serde_json::json!({"refusal": refusal}),
                        meshrix_entry_core::service::RecoveryImportPhase::SnapshotUnusable { reason } =>
                            serde_json::json!({"reason": reason}),
                        _ => serde_json::Value::Null,
                    },
                }));
            }
        },
        Command::Grant { command } => match command {
            GrantCommand::Catalog { connection_id } => {
                print_json(&serde_json::to_value(service.load_grant_catalog(connection_id).await?)?);
            }
            GrantCommand::Request { connection_id, scopes } => {
                let (_view, transaction) =
                    service.request_grant_access(connection_id, scopes.clone()).await?;
                println!("approve the grant in your browser (code {}):\n{}", transaction.user_code, transaction.browser_url);
                for _ in 0..150 {
                    match service.poll_grant_access(&transaction).await? {
                        meshrix_entry_core::service::GrantPoll::Pending => {}
                        meshrix_entry_core::service::GrantPoll::Granted(view) => {
                            print_json(&serde_json::to_value(view)?);
                            return Ok(());
                        }
                        meshrix_entry_core::service::GrantPoll::Expired => {
                            bail!("the grant authorization expired; request again");
                        }
                        meshrix_entry_core::service::GrantPoll::Consumed => {
                            bail!("the grant authorization was consumed without completing");
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                bail!("grant approval timed out");
            }
        },
        Command::Tui => unreachable!(),
    }
    std::io::stdout().flush().ok();
    Ok(())
}

/// The endpoint enrollment step-up driver for a terminal: create the
/// `pair_device` transaction bound to the claim id, print the browser URL,
/// and poll until the verified permit lands (or the window lapses).
fn endpoint_step_up_driver(service: std::sync::Arc<EntryService>) -> StepUpDriver {
    std::sync::Arc::new(move |request: PersonalEndpointStepUpRequest| {
        let service = service.clone();
        Box::pin(async move {
            let tx = service.begin_endpoint_step_up(&request)?;
            println!("approve the personal route claim in your browser (code {}):\n{}", tx.user_code, tx.browser_url);
            for _ in 0..150 {
                tokio::time::sleep(Duration::from_secs(2)).await;
                match service.poll_endpoint_step_up(&request, &tx)? {
                    StepUpPoll::Pending => {}
                    StepUpPoll::Expired | StepUpPoll::Consumed => {
                        return Err(meshrix_entry_core::error::entry_error(
                            "account_step_up_expired",
                            "The personal route approval expired; start enrollment again.",
                        ));
                    }
                    StepUpPoll::Complete { account, permit_id, target } => {
                        return Ok(PersonalEndpointStepUpResult { account, permit_id, target });
                    }
                }
            }
            Err(meshrix_entry_core::error::entry_error(
                "account_step_up_expired",
                "Timed out waiting for the personal route approval.",
            ))
        }) as futures_util::future::LocalBoxFuture<
            'static,
            meshrix_entry_core::Result<PersonalEndpointStepUpResult>,
        >
    })
}

/// `NAME=VALUE` passes a host environment variable name; `NAME=@ref` stores
/// a custody reference that resolves at agent launch time only.
fn agent_input(
    id: Option<String>,
    name: &str,
    command: &str,
    args: &[String],
    cwd: &Option<PathBuf>,
    environment: &[String],
) -> anyhow::Result<meshrix_entry_core::agent::registry::AcpAgentDefinitionInput> {
    use meshrix_entry_core::agent::registry::AcpEnvironmentSource;
    let mut env = std::collections::BTreeMap::new();
    for entry in environment {
        let Some((k, v)) = entry.split_once('=') else {
            bail!("env entries must be NAME=VALUE or NAME=@custody-ref")
        };
        let source = if let Some(reference) = v.strip_prefix('@') {
            AcpEnvironmentSource::SecretReference { reference: reference.to_string() }
        } else {
            AcpEnvironmentSource::HostEnvironment { variable: v.to_string() }
        };
        env.insert(k.to_string(), source);
    }
    Ok(meshrix_entry_core::agent::registry::AcpAgentDefinitionInput {
        id,
        display_name: name.to_string(),
        description: None,
        command: command.to_string(),
        args: args.to_vec(),
        cwd: cwd.clone().unwrap_or(std::env::current_dir()?),
        environment: env,
        enabled: true,
    })
}

/// Stream one operation's durable record changes until a terminal status —
/// progress, permission prompts and the final result all surface here.
async fn watch_operation(
    service: &EntryService,
    events: &mut tokio::sync::broadcast::Receiver<meshrix_entry_core::peer::PeerHostEvent>,
    operation_id: &str,
) -> anyhow::Result<()> {
    use meshrix_entry_core::peer::PeerHostEvent;
    const TERMINAL: &[&str] = &["completed", "failed", "cancelled"];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
    let mut last_revision = 0u64;
    loop {
        tokio::select! {
            biased;
            event = events.recv() => {
                match event {
                    Ok(PeerHostEvent::ApplicationOperation(record))
                        if record.operation_id == operation_id =>
                    {
                        if record.state_revision != last_revision {
                            last_revision = record.state_revision;
                            if let Some(progress) = &record.progress {
                                println!("… {}", progress.text);
                            }
                            if let Some(permission) = &record.permission {
                                if permission.status == "pending" {
                                    println!("permission requested: {} (permit {})",
                                        permission.request.tool_call.title, permission.id);
                                }
                            }
                        }
                        if TERMINAL.contains(&record.status.as_str()) {
                            if let Some(text) = &record.result_text {
                                println!("{text}");
                            }
                            if let Some(err) = &record.last_error {
                                eprintln!("error: {err}");
                            }
                            println!("status: {}", record.status);
                            return Ok(());
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        bail!("peer host stopped")
                    }
                }
            }
            // Safety net: re-read the durable record every 5s so a missed
            // broadcast never strands the wait.
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                if let Some(record) = service.application_operation(operation_id).await? {
                    if TERMINAL.contains(&record.status.as_str()) {
                        if let Some(text) = &record.result_text {
                            println!("{text}");
                        }
                        println!("status: {}", record.status);
                        return Ok(());
                    }
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                bail!("timed out waiting for the operation to finish")
            }
        }
    }
}

fn session_view(session: &meshrix_entry_core::relay::EntrySession) -> Value {
    let s = session.state();
    json!({
        "sessionState": s.session_state,
        "routeState": s.route_state,
        "sessionId": s.session_id,
        "acceptsNewWork": s.accepts_new_work,
    })
}

mod agent_mcp {
    //! Agent-facing MCP surface: the same six-tool contract the desktop
    //! `--mcp-stdio` owner bridge serves (`personal-mcp.ts`), backed by
    //! `EntryService` directly so hosts can use it headless — no running
    //! GUI owner required.

    use std::sync::Arc;

    use meshrix_entry_core::error::EntryError;
    use meshrix_entry_core::service::EntryService;
    use serde_json::{json, Value};

    fn tools() -> Value {
        json!([{
            "name": "meshrix_list_destinations",
            "description": "List paired Meshrix devices that can receive an Agent task. Use the returned destinationHandle exactly as provided.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "meshrix_discover_agents",
            "description": "Discover the enrolled Agents available on one paired device.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "destinationHandle": { "type": "string", "minLength": 1 },
                    "requestId": { "type": "string", "minLength": 2, "maxLength": 128 }
                },
                "required": ["destinationHandle"],
                "additionalProperties": false
            }
        },
        {
            "name": "meshrix_send_task",
            "description": "Send a task to an enrolled Agent on a paired device. Generate one operationId per new task; reuse the same value to retry an unknown response, then query task status before attempting another call. A disconnected route rejects new work without accepting it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "operationId": { "type": "string", "minLength": 8, "maxLength": 128 },
                    "destinationHandle": { "type": "string", "minLength": 1 },
                    "targetAgentId": { "type": "string", "minLength": 1 },
                    "prompt": { "type": "string", "minLength": 1 },
                    "model": { "type": "string", "description": "Optional remote model selector as model[effort]." }
                },
                "required": ["operationId", "destinationHandle", "targetAgentId", "prompt"],
                "additionalProperties": false
            }
        },
        {
            "name": "meshrix_list_tasks",
            "description": "List durable local Meshrix Agent task history, including transport and execution state.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "meshrix_get_task",
            "description": "Read one durable Meshrix task by its operationId. Completed results come from this profile's protected local application journal.",
            "inputSchema": {
                "type": "object",
                "properties": { "operationId": { "type": "string", "minLength": 1 } },
                "required": ["operationId"],
                "additionalProperties": false
            }
        },
        {
            "name": "meshrix_cancel_task",
            "description": "Request cancellation of a Meshrix Agent task. Cancellation may be pending while the remote device is unreachable; check task status for the final outcome.",
            "inputSchema": {
                "type": "object",
                "properties": { "operationId": { "type": "string", "minLength": 1 } },
                "required": ["operationId"],
                "additionalProperties": false
            }
        }])
    }

    fn rpc_result(id: &Value, result: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    }

    fn rpc_error(id: &Value, code: i64, message: impl Into<String>, data: Option<Value>) -> Value {
        let mut error = json!({ "code": code, "message": message.into() });
        if let Some(data) = data {
            error.as_object_mut().unwrap().insert("data".into(), data);
        }
        json!({ "jsonrpc": "2.0", "id": id, "error": error })
    }

    fn tool_result(value: Value) -> Value {
        let mut structured = value.clone();
        if structured.is_null() {
            structured = json!({ "found": false });
        } else if structured.is_array() {
            structured = json!({ "items": structured });
        }
        json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".into()) }],
            "structuredContent": structured,
        })
    }

    fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
        args.get(key).and_then(Value::as_str)
    }

    /// Honest effect semantics: never fabricated success. `not_started`
    /// keeps the caller free to retry the same operationId; anything else is
    /// `operation_status_unknown` — query before submitting again.
    fn dispatch_error(id: &Value, error: &EntryError, operation_id: Option<&str>) -> Value {
        let not_started = error.effect.as_deref() == Some("not_started")
            || error.effect.as_deref() == Some(meshrix_entry_core::error::effect_outcome::NOT_REQUIRED);
        let mut data = json!({
            "code": error.code,
            "effectOutcome": if not_started { "not_started" } else { "unknown" },
        });
        if let Some(op) = operation_id {
            data.as_object_mut().unwrap().insert("operationId".into(), op.into());
        }
        if !not_started {
            data.as_object_mut().unwrap().insert(
                "instruction".into(),
                "Query meshrix_get_task with this same operationId before submitting again.".into(),
            );
        }
        rpc_error(
            id,
            -32000,
            if not_started {
                "The destination is unreachable; the task was not submitted."
            } else {
                "The task submission reply was lost; its outcome is unknown."
            },
            Some(data),
        )
    }

    pub async fn handle(service: &Arc<EntryService>, body: &Value) -> Option<Value> {
        if body.is_array()
            || !body.is_object()
            || body.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || body.get("method").and_then(Value::as_str).is_none()
        {
            return Some(rpc_error(&Value::Null, -32600, "Invalid JSON-RPC request.", None));
        }
        let method = body.get("method").and_then(Value::as_str).unwrap();
        let Some(id) = body.get("id") else { return None };
        let id = id.clone();

        match method {
            "initialize" => {
                return Some(rpc_result(&id, json!({
                    "protocolVersion": body.get("params").and_then(|p| p.get("protocolVersion")).and_then(Value::as_str).unwrap_or("2025-06-18"),
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "meshrix-entry", "version": env!("CARGO_PKG_VERSION") },
                })));
            }
            "ping" => return Some(rpc_result(&id, json!({}))),
            "tools/list" => return Some(rpc_result(&id, json!({ "tools": tools() }))),
            "tools/call" => {}
            _ => return Some(rpc_error(&id, -32601, format!("Method not found: {method}"), None)),
        }

        let params = body.get("params").cloned().unwrap_or(Value::Null);
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or(Value::Null);
        let known = tools()
            .as_array()
            .map(|t| t.iter().any(|t| t.get("name").and_then(Value::as_str) == Some(name)))
            .unwrap_or(false);
        if !known {
            return Some(rpc_error(&id, -32602, "Unknown Meshrix tool.", None));
        }

        let call: std::result::Result<Value, anyhow::Error> = async {
            match name {
                "meshrix_list_destinations" => {
                    let destinations: Vec<Value> = service
                        .state()
                        .connections
                        .iter()
                        .map(|c| {
                            json!({
                                "destinationHandle": c.connection_id,
                                "displayLabel": c.display_label,
                                "endpointDeviceId": c.endpoint_device_id,
                                "sessionState": c.session_state,
                                "routeState": c.route_state,
                                "rePairRequired": c.re_pair_required,
                            })
                        })
                        .collect();
                    Ok(json!({ "destinations": destinations }))
                }
                "meshrix_discover_agents" => {
                    let handle_id = arg(&args, "destinationHandle")
                        .ok_or_else(|| anyhow::anyhow!("destinationHandle is required"))?;
                    service.connect(handle_id).await?;
                    let record = service
                        .application_discover(handle_id, arg(&args, "requestId").map(str::to_string))
                        .await?;
                    serde_json::to_value(record).map_err(anyhow::Error::from)
                }
                "meshrix_send_task" => {
                    let operation_id = arg(&args, "operationId")
                        .ok_or_else(|| anyhow::anyhow!("operationId is required"))?;
                    let handle_id = arg(&args, "destinationHandle")
                        .ok_or_else(|| anyhow::anyhow!("destinationHandle is required"))?;
                    let agent = arg(&args, "targetAgentId")
                        .ok_or_else(|| anyhow::anyhow!("targetAgentId is required"))?;
                    let prompt = arg(&args, "prompt")
                        .ok_or_else(|| anyhow::anyhow!("prompt is required"))?;
                    service.connect(handle_id).await?;
                    let record = service
                        .application_submit(
                            handle_id,
                            Some(operation_id.to_string()),
                            None,
                            agent,
                            prompt,
                            arg(&args, "model").map(str::to_string),
                        )
                        .await?;
                    serde_json::to_value(record).map_err(anyhow::Error::from)
                }
                "meshrix_list_tasks" => serde_json::to_value(service.application_operations().await?)
                    .map_err(anyhow::Error::from),
                "meshrix_get_task" => {
                    let operation_id = arg(&args, "operationId")
                        .ok_or_else(|| anyhow::anyhow!("operationId is required"))?;
                    match service.application_operation(operation_id).await? {
                        Some(record) => serde_json::to_value(record).map_err(anyhow::Error::from),
                        None => Ok(Value::Null),
                    }
                }
                "meshrix_cancel_task" => {
                    let operation_id = arg(&args, "operationId")
                        .ok_or_else(|| anyhow::anyhow!("operationId is required"))?;
                    serde_json::to_value(service.application_cancel(operation_id).await?)
                        .map_err(anyhow::Error::from)
                }
                _ => unreachable!(),
            }
        }
        .await;

        match call {
            Ok(value) => Some(rpc_result(&id, tool_result(value))),
            Err(error) => {
                let entry = error.downcast_ref::<EntryError>();
                let operation_id = arg(&args, "operationId");
                match entry {
                    Some(e) => Some(dispatch_error(&id, e, operation_id)),
                    None => Some(rpc_error(&id, -32000, error.to_string(), operation_id.map(|o| json!({ "operationId": o })))),
                }
            }
        }
    }
}

mod tui {
    //! Ratatui dashboard: connections table + live session/event feed.

    use std::sync::Arc;
    use std::time::Duration;

    use anyhow::Result;
    use crossterm::event::{self, Event, KeyCode};
    use crossterm::execute;
    use crossterm::terminal::{
        disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
    };
    use meshrix_entry_core::peer::{AcpPermissionResolution, PeerApplicationRecord, PeerHostEvent};
    use meshrix_entry_core::relay::EntrySessionEvent;
    use meshrix_entry_core::service::{EntryService, ServiceState};
    use ratatui::backend::CrosstermBackend;
    use ratatui::layout::{Constraint, Direction, Layout};
    use ratatui::style::{Modifier, Style};
    use ratatui::widgets::{Block, Borders, Cell, Paragraph, Row, Table};
    use ratatui::Terminal;
    use tokio::sync::mpsc;

    enum Msg {
        Tick,
        Key(KeyCode),
        Event(String, EntrySessionEvent),
        /// Durable operation record pushed by the peer host.
        Op(PeerApplicationRecord),
        Log(String),
    }

    pub async fn run(service: EntryService) -> Result<()> {
        enable_raw_mode()?;
        let mut stdout = std::io::stdout();
        execute!(stdout, EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(stdout);
        let mut terminal = Terminal::new(backend)?;

        let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
        let key_tx = tx.clone();
        std::thread::spawn(move || loop {
            if let Ok(Event::Key(k)) = event::read() {
                if key_tx.send(Msg::Key(k.code)).is_err() {
                    return;
                }
            }
        });
        let tick_tx = tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if tick_tx.send(Msg::Tick).is_err() {
                    return;
                }
            }
        });

        let service = Arc::new(service);
        let mut selected = 0usize;
        let mut logs: Vec<String> = Vec::new();
        let mut ops: std::collections::HashMap<String, PeerApplicationRecord> = Default::default();
        let mut watchers: std::collections::HashMap<String, ()> = Default::default();

        // Peer host feed — durable operation changes drive the ops panel.
        if let Ok(mut feed) = service.peer_events() {
            let tx = tx.clone();
            tokio::spawn(async move {
                loop {
                    match feed.recv().await {
                        Ok(PeerHostEvent::ApplicationOperation(record)) => {
                            if tx.send(Msg::Op(record)).is_err() {
                                return;
                            }
                        }
                        Ok(PeerHostEvent::PeerClient { connection_id, event }) => {
                            if tx
                                .send(Msg::Log(format!("{connection_id}: peer {event:?}")))
                                .is_err()
                            {
                                return;
                            }
                        }
                        Ok(PeerHostEvent::ApplicationDiscovery(record)) => {
                            if tx
                                .send(Msg::Log(format!(
                                    "discovery {}: {} agent(s)",
                                    record.request_id,
                                    record.agents.len()
                                )))
                                .is_err()
                            {
                                return;
                            }
                        }
                        Ok(PeerHostEvent::Endpoint(snapshot)) => {
                            if tx
                                .send(Msg::Log(format!(
                                    "endpoint: {} ({})",
                                    snapshot.state, snapshot.relay_state
                                )))
                                .is_err()
                            {
                                return;
                            }
                        }
                        Err(_) => return,
                    }
                }
            });
        }

        let result: Result<()> = async {
            loop {
                let state = service.state();
                for conn in &state.connections {
                    if watchers.contains_key(&conn.connection_id) {
                        continue;
                    }
                    if let Ok(session) = service.connect(&conn.connection_id).await {
                        watchers.insert(conn.connection_id.clone(), ());
                        let mut events = session.events();
                        let id = conn.connection_id.clone();
                        let tx = tx.clone();
                        tokio::spawn(async move {
                            while events.changed().await.is_ok() {
                                let ev = events.borrow().clone();
                                if tx.send(Msg::Event(id.clone(), ev)).is_err() {
                                    return;
                                }
                            }
                        });
                    }
                }
                terminal.draw(|f| draw(f, &state, selected, &logs, &ops, &service))?;
                let Some(msg) = rx.recv().await else { break };
                match msg {
                    Msg::Tick => {}
                    Msg::Key(KeyCode::Char('q')) | Msg::Key(KeyCode::Esc) => break,
                    Msg::Key(KeyCode::Down) | Msg::Key(KeyCode::Char('j')) => {
                        if selected + 1 < state.connections.len() {
                            selected += 1;
                        }
                    }
                    Msg::Key(KeyCode::Up) | Msg::Key(KeyCode::Char('k')) => {
                        selected = selected.saturating_sub(1);
                    }
                    Msg::Key(KeyCode::Char('d')) => {
                        if let Some(c) = state.connections.get(selected) {
                            service.disconnect(&c.connection_id).await;
                            logs.push(format!("disconnected {}", c.connection_id));
                        }
                    }
                    Msg::Event(id, ev) => {
                        logs.push(format!("{id}: {ev:?}"));
                        if logs.len() > 200 {
                            logs.drain(..logs.len() - 200);
                        }
                    }
                    Msg::Log(line) => {
                        logs.push(line);
                        if logs.len() > 200 {
                            logs.drain(..logs.len() - 200);
                        }
                    }
                    Msg::Op(record) => {
                        if let Some(permission) = &record.permission {
                            if permission.status == "pending" {
                                logs.push(format!(
                                    "{}: permission — {}",
                                    record.operation_id, permission.request.tool_call.title
                                ));
                            }
                        }
                        ops.insert(record.operation_id.clone(), record);
                    }
                    // Operation keys: 1-9 select a pending permission option,
                    // n denies, x cancels the newest non-terminal op.
                    Msg::Key(KeyCode::Char(c)) if c.is_ascii_digit() => {
                        let idx = c.to_digit(10).unwrap() as usize - 1;
                        if let Some(op) = ops
                            .values()
                            .find(|o| o.permission.as_ref().is_some_and(|p| p.status == "pending"))
                        {
                            let op = op.clone();
                            if let Some(option) = op
                                .permission
                                .as_ref()
                                .and_then(|p| p.request.options.get(idx))
                            {
                                let service = service.clone();
                                let oid = op.operation_id.clone();
                                let pid = op.permission.as_ref().unwrap().id.clone();
                                let opt = option.option_id.clone();
                                tokio::spawn(async move {
                                    let _ = service
                                        .application_resolve_permission(
                                            &oid,
                                            &pid,
                                            AcpPermissionResolution::Selected { option_id: opt },
                                        )
                                        .await;
                                });
                            }
                        }
                    }
                    Msg::Key(KeyCode::Char('n')) => {
                        if let Some(op) = ops
                            .values()
                            .find(|o| o.permission.as_ref().is_some_and(|p| p.status == "pending"))
                            .cloned()
                        {
                            let service = service.clone();
                            let oid = op.operation_id.clone();
                            let pid = op.permission.as_ref().unwrap().id.clone();
                            tokio::spawn(async move {
                                let _ = service
                                    .application_resolve_permission(
                                        &oid,
                                        &pid,
                                        AcpPermissionResolution::Cancelled,
                                    )
                                    .await;
                            });
                        }
                    }
                    Msg::Key(KeyCode::Char('x')) => {
                        if let Some(op) = ops
                            .values()
                            .filter(|o| !matches!(o.status.as_str(), "completed" | "failed" | "cancelled"))
                            .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
                            .cloned()
                        {
                            let service = service.clone();
                            tokio::spawn(async move {
                                let _ = service.application_cancel(&op.operation_id).await;
                            });
                        }
                    }
                    _ => {}
                }
            }
            Ok(())
        }
        .await;

        disable_raw_mode()?;
        execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
        result
    }

    fn draw(
        f: &mut ratatui::Frame,
        state: &ServiceState,
        selected: usize,
        logs: &[String],
        ops: &std::collections::HashMap<String, PeerApplicationRecord>,
        service: &EntryService,
    ) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(9),
                Constraint::Length(8),
            ])
            .split(f.area());
        let recovery_state = service
            .recovery_view()
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .replace('_', " ");
        let header = Paragraph::new(format!(
            "meshrix-entry — account: {} — connections: {} — recovery: {} — (q quit, j/k move, d disconnect, x cancel op, 1-9/n permit)",
            if state.account_signed_in { "signed in" } else { "signed out" },
            state.connections.len(),
            recovery_state,
        ))
        .block(Block::default().borders(Borders::ALL).title("Status"));
        f.render_widget(header, chunks[0]);

        let rows: Vec<Row> = state
            .connections
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let style = if i == selected {
                    Style::default().add_modifier(Modifier::REVERSED)
                } else {
                    Style::default()
                };
                Row::new(vec![
                    Cell::from(c.display_label.clone()),
                    Cell::from(format!("{}/{}", c.tenant_id, c.route_id)),
                    Cell::from(c.session_state.clone().unwrap_or_else(|| "idle".into())),
                    Cell::from(c.route_state.clone().unwrap_or_else(|| "-".into())),
                    Cell::from(if c.re_pair_required { "re-pair" } else { "ok" }),
                ])
                .style(style)
            })
            .collect();
        let table = Table::new(
            rows,
            [
                Constraint::Percentage(30),
                Constraint::Percentage(30),
                Constraint::Percentage(15),
                Constraint::Percentage(15),
                Constraint::Percentage(10),
            ],
        )
        .header(Row::new(vec!["label", "tenant/route", "session", "route", "flags"]))
        .block(Block::default().borders(Borders::ALL).title("Connections"));
        f.render_widget(table, chunks[1]);

        let mut op_list: Vec<&PeerApplicationRecord> = ops.values().collect();
        op_list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let op_rows: Vec<Row> = op_list
            .iter()
            .take(6)
            .map(|o| {
                let pending = o
                    .permission
                    .as_ref()
                    .is_some_and(|p| p.status == "pending");
                Row::new(vec![
                    Cell::from(o.operation_id[..o.operation_id.len().min(22)].to_string()),
                    Cell::from(o.target_agent_id.clone()),
                    Cell::from(if pending {
                        format!("{} ⚠", o.status)
                    } else {
                        o.status.clone()
                    }),
                    Cell::from(o.progress.as_ref().map(|p| p.text.clone()).unwrap_or_default()),
                ])
            })
            .collect();
        let op_table = Table::new(
            op_rows,
            [
                Constraint::Percentage(30),
                Constraint::Percentage(20),
                Constraint::Percentage(18),
                Constraint::Percentage(32),
            ],
        )
        .header(Row::new(vec!["operation", "agent", "status", "progress"]))
        .block(Block::default().borders(Borders::ALL).title("Operations"));
        f.render_widget(op_table, chunks[2]);

        let log_text = logs
            .iter()
            .rev()
            .take(6)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let log = Paragraph::new(log_text)
            .block(Block::default().borders(Borders::ALL).title("Session events"));
        f.render_widget(log, chunks[3]);
    }
}
