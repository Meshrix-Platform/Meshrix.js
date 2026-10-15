//! `agent-registry.ts` — owner-only command registry and generic ACP
//! subprocess directory. Environment values are resolved at launch and are
//! never written to the registry document.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use futures_util::future::LocalBoxFuture;
use serde::{Deserialize, Serialize};

use crate::error::entry_error;
use crate::peer::application::AcpAgentSummary;
use crate::peer::application_engine::{
    PeerApplicationAgentDirectory, PeerApplicationAgentExecutor,
};
use crate::Result;

use super::executor::AcpSubprocessExecutor;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcpEnvironmentSource {
    HostEnvironment { variable: String },
    SecretReference { reference: String },
    /// Compiled-in literal from a built-in detection adapter — registered
    /// definitions keep reference-only sources.
    Literal { value: String },
}

/// Local-only execution authority. Remote input can select only this id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentDefinition {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Environment values are resolved at launch; only references persist.
    pub environment: BTreeMap<String, AcpEnvironmentSource>,
    pub permission_policy: String,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct AcpAgentDefinitionInput {
    pub id: Option<String>,
    pub display_name: String,
    pub description: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub environment: BTreeMap<String, AcpEnvironmentSource>,
    pub enabled: bool,
}

/// Resolves `secret_reference` environment sources from local custody.
/// Implementations must be `Send + Sync` — the resolver is shared between
/// the service thread and the dedicated peer host thread.
pub trait AcpAgentSecretResolver: Send + Sync {
    fn resolve(&self, reference: &str) -> LocalBoxFuture<'static, Option<String>>;
}

#[derive(Debug, Serialize, Deserialize)]
struct RegistryDocument {
    version: u64,
    agents: BTreeMap<String, AcpAgentDefinition>,
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_agent_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    id.len() >= 2 && id.len() <= 127 && id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn is_secret_reference(reference: &str) -> bool {
    let mut chars = reference.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    reference.len() <= 251 && reference
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn validate_definition(
    input: AcpAgentDefinitionInput,
    existing_id: Option<&str>,
) -> Result<AcpAgentDefinition> {
    let id = existing_id
        .map(str::to_string)
        .or(input.id)
        .unwrap_or_else(|| format!("agent.{}", crate::peer::client::uuid_simple()));
    if !is_agent_id(&id) {
        return Err(entry_error("agent_definition_invalid", "Agent id is invalid."));
    }
    let display_name = input.display_name.trim().to_string();
    if display_name.is_empty() || display_name.len() > 256 {
        return Err(entry_error(
            "agent_definition_invalid",
            "Agent display name is invalid.",
        ));
    }
    if let Some(description) = &input.description {
        if description.len() > 2048 {
            return Err(entry_error(
                "agent_definition_invalid",
                "Agent description is invalid.",
            ));
        }
    }
    if input.command.trim().is_empty() || input.command.len() > 2048 {
        return Err(entry_error("agent_definition_invalid", "Agent command is invalid."));
    }
    if input.args.iter().any(|arg| arg.len() > 8192) {
        return Err(entry_error(
            "agent_definition_invalid",
            "Agent command arguments are invalid.",
        ));
    }
    if !input.cwd.is_absolute() {
        return Err(entry_error(
            "agent_definition_invalid",
            "Agent working directory must be absolute.",
        ));
    }
    let mut environment: BTreeMap<String, AcpEnvironmentSource> = BTreeMap::new();
    for (name, source) in input.environment {
        if !is_env_name(&name) {
            return Err(entry_error(
                "agent_definition_invalid",
                "Agent environment mapping is invalid.",
            ));
        }
        let valid = match &source {
            AcpEnvironmentSource::HostEnvironment { variable } => is_env_name(variable),
            AcpEnvironmentSource::SecretReference { reference } => is_secret_reference(reference),
            AcpEnvironmentSource::Literal { value } => !value.is_empty(),
        };
        if !valid {
            return Err(entry_error(
                "agent_definition_invalid",
                "Agent environment source is invalid.",
            ));
        }
        environment.insert(name, source);
    }
    Ok(AcpAgentDefinition {
        id,
        display_name,
        description: input.description.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()),
        command: input.command,
        args: input.args,
        cwd: input.cwd.canonicalize().unwrap_or(input.cwd),
        environment,
        permission_policy: "ask".to_string(),
        enabled: input.enabled,
    })
}

fn summary_of(definition: &AcpAgentDefinition) -> AcpAgentSummary {
    AcpAgentSummary {
        id: definition.id.clone(),
        display_name: definition.display_name.clone(),
        description: definition.description.clone(),
        enabled: definition.enabled,
        detected: None,
        transport: Some("acp".to_string()),
    }
}

fn store_error(detail: &str) -> crate::EntryError {
    entry_error("agent_store_error", detail)
}

/// `FileAcpAgentRegistry` — durable owner-only registry + executor factory.
pub struct FileAcpAgentRegistry {
    file_path: PathBuf,
    secret_resolver: Arc<dyn AcpAgentSecretResolver>,
    executors: RefCell<BTreeMap<String, Rc<AcpSubprocessExecutor>>>,
    document: RefCell<Option<RegistryDocument>>,
    /// Mtime of the file as last loaded — a changed file forces re-parse.
    file_mtime: RefCell<Option<std::time::SystemTime>>,
    /// Serializes mutations — the TS `#writeTail` promise chain.
    write_lock: tokio::sync::Mutex<()>,
}

impl FileAcpAgentRegistry {
    pub fn new(
        file_path: PathBuf,
        secret_resolver: Arc<dyn AcpAgentSecretResolver>,
    ) -> Result<Rc<Self>> {
        if file_path.as_os_str().is_empty() {
            return Err(store_error("An agent registry file is required."));
        }
        let file_path = file_path
            .canonicalize()
            .unwrap_or_else(|_| file_path.to_path_buf());
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| store_error("The agent registry directory cannot be created."))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
        Ok(Rc::new(Self {
            file_path,
            secret_resolver,
            executors: RefCell::new(BTreeMap::new()),
            document: RefCell::new(None),
            file_mtime: RefCell::new(None),
            write_lock: tokio::sync::Mutex::new(()),
        }))
    }

    fn load(&self) -> Result<()> {
        let on_disk = std::fs::metadata(&self.file_path)
            .ok()
            .and_then(|m| m.modified().ok());
        if self.document.borrow().is_some() && on_disk == *self.file_mtime.borrow() {
            return Ok(());
        }
        let text = match std::fs::read_to_string(&self.file_path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                *self.document.borrow_mut() = Some(RegistryDocument {
                    version: 1,
                    agents: BTreeMap::new(),
                });
                *self.file_mtime.borrow_mut() = None;
                return Ok(());
            }
            Err(_) => return Err(store_error("The agent registry cannot be read.")),
        };
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| store_error("Agent registry document is malformed."))?;
        if !value.is_object() {
            return Err(store_error("Agent registry document is malformed."));
        }
        if value.get("version").and_then(|v| v.as_u64()) != Some(1)
            || !value.get("agents").map(|a| a.is_object()).unwrap_or(false)
        {
            return Err(store_error("Agent registry document is unsupported."));
        }
        let mut agents = BTreeMap::new();
        for (id, candidate) in value["agents"].as_object().unwrap() {
            if !candidate.is_object() {
                return Err(store_error("Agent registry entry is malformed."));
            }
            let input: AcpAgentDefinitionInputStored = serde_json::from_value(candidate.clone())
                .map_err(|_| store_error("Agent registry entry is malformed."))?;
            let definition = validate_definition(
                AcpAgentDefinitionInput {
                    id: None,
                    display_name: input.display_name,
                    description: input.description,
                    command: input.command,
                    args: input.args,
                    cwd: input.cwd,
                    environment: input.environment,
                    enabled: input.enabled.unwrap_or(true),
                },
                Some(id),
            )?;
            agents.insert(id.clone(), definition);
        }
        *self.document.borrow_mut() = Some(RegistryDocument { version: 1, agents });
        *self.file_mtime.borrow_mut() = std::fs::metadata(&self.file_path)
            .ok()
            .and_then(|m| m.modified().ok());
        Ok(())
    }

    async fn mutate<T>(
        &self,
        operation: impl FnOnce(&RegistryDocument) -> Result<(Option<RegistryDocument>, T)>,
    ) -> Result<T> {
        let _guard = self.write_lock.lock().await;
        self.load()?;
        let (document, value) = {
            let borrowed = self.document.borrow();
            let current = borrowed.as_ref().expect("document loaded");
            operation(current)?
        };
        if let Some(document) = document {
            let text = format!("{}\n", serde_json::to_string(&document).map_err(|_| {
                store_error("Agent registry document cannot be encoded.")
            })?);
            write_private_file_atomic(&self.file_path, text.as_bytes())?;
            *self.file_mtime.borrow_mut() = std::fs::metadata(&self.file_path)
                .ok()
                .and_then(|m| m.modified().ok());
            *self.document.borrow_mut() = Some(document);
        }
        Ok(value)
    }

    pub async fn register(&self, input: AcpAgentDefinitionInput) -> Result<AcpAgentSummary> {
        let definition = validate_definition(input, None)?;
        let summary = self
            .mutate(|document| {
                if document.agents.contains_key(&definition.id) {
                    return Err(entry_error(
                        "agent_definition_invalid",
                        "An Agent with this id already exists.",
                    ));
                }
                let mut agents = document.agents.clone();
                agents.insert(definition.id.clone(), definition.clone());
                Ok((
                    Some(RegistryDocument { version: 1, agents }),
                    summary_of(&definition),
                ))
            })
            .await?;
        self.executors.borrow_mut().remove(&summary.id);
        Ok(summary)
    }

    pub async fn update(
        &self,
        id: &str,
        patch: AcpAgentDefinitionInput,
    ) -> Result<AcpAgentSummary> {
        let summary = self
            .mutate(|document| {
                let previous = document.agents.get(id).ok_or_else(|| {
                    entry_error("agent_definition_invalid", "The local Agent does not exist.")
                })?;
                let merged = AcpAgentDefinitionInput {
                    id: Some(id.to_string()),
                    display_name: patch.display_name,
                    description: patch.description.or(previous.description.clone()),
                    command: patch.command,
                    args: patch.args,
                    cwd: patch.cwd,
                    environment: patch.environment,
                    enabled: patch.enabled,
                };
                let definition = validate_definition(merged, Some(id))?;
                let summary = summary_of(&definition);
                let mut agents = document.agents.clone();
                agents.insert(id.to_string(), definition);
                Ok((Some(RegistryDocument { version: 1, agents }), summary))
            })
            .await?;
        self.executors.borrow_mut().remove(id);
        Ok(summary)
    }

    pub async fn remove(&self, id: &str) -> Result<bool> {
        let removed = self
            .mutate(|document| {
                if !document.agents.contains_key(id) {
                    return Ok((None, false));
                }
                let mut agents = document.agents.clone();
                agents.remove(id);
                Ok((Some(RegistryDocument { version: 1, agents }), true))
            })
            .await?;
        if removed {
            self.executors.borrow_mut().remove(id);
        }
        Ok(removed)
    }

    pub async fn resolve_definition(&self, agent_id: &str) -> Result<Option<AcpAgentDefinition>> {
        self.load()?;
        Ok(self
            .document
            .borrow()
            .as_ref()
            .and_then(|d| d.agents.get(agent_id).cloned()))
    }
}

impl PeerApplicationAgentDirectory for FileAcpAgentRegistry {
    fn list(&self) -> LocalBoxFuture<'_, Result<Vec<AcpAgentSummary>>> {
        Box::pin(async move {
            self.load()?;
            Ok(self
                .document
                .borrow()
                .as_ref()
                .map(|d| d.agents.values().map(summary_of).collect())
                .unwrap_or_default())
        })
    }

    fn get(&self, agent_id: &str) -> Option<Rc<dyn PeerApplicationAgentExecutor>> {
        let definition = {
            self.load().ok()?;
            self.document
                .borrow()
                .as_ref()
                .and_then(|d| d.agents.get(agent_id).cloned())
        }?;
        if !definition.enabled {
            return None;
        }
        let mut executors = self.executors.borrow_mut();
        if let Some(executor) = executors.get(agent_id) {
            if executor.definition == definition {
                return Some(executor.clone());
            }
        }
        let executor = Rc::new(AcpSubprocessExecutor::new(
            definition,
            self.secret_resolver.clone(),
        ));
        executors.insert(agent_id.to_string(), executor.clone());
        Some(executor)
    }
}

/// Persisted shape — `permissionPolicy` is always "ask" and is not stored
/// redundantly in input form.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpAgentDefinitionInputStored {
    display_name: String,
    description: Option<String>,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: PathBuf,
    #[serde(default)]
    environment: BTreeMap<String, AcpEnvironmentSource>,
    enabled: Option<bool>,
}

fn write_private_file_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    crate::peer::store::atomic_write(path, bytes)
        .map_err(|_| store_error("The agent registry file could not be written."))
}
