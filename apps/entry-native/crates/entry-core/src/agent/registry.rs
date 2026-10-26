//! Durable Meshrix enrollment around A4AA and AwP.
//!
//! A4AA cards supply product facts and base `AgentSpec`s. AwP owns profile
//! shape, field merging, validation, and resolution. This module persists an
//! AwP document plus the small amount of Meshrix-only selection metadata and
//! converts the former `agents.json` format once when it is first opened.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use futures_util::future::LocalBoxFuture;
use serde::{Deserialize, Serialize};

use a4aa::card::ModelCatalog;
use a4aa::env::{EnvPolicy, EnvSource, EnvValue};
use a4aa::model::{CommandSpec, LaneSpec};
use a4aa::{AgentSpec, SelectorPhase, SelectorSupport};
use awp::{AgentEntry, Profile, ProfilePatch, Registry, RegistryDocument};

use crate::error::entry_error;
use crate::peer::application::AcpAgentSummary;
use crate::peer::application_engine::{
    PeerApplicationAgentDirectory, PeerApplicationAgentExecutor,
};
use crate::Result;

use super::detect::{self, DetectedAgent};
use super::executor::ProfiledAgentExecutor;

const CURRENT_DOCUMENT_VERSION: u64 = 2;

/// Meshrix policy that is not part of an A4AA AgentSpec or an AwP Profile.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostMetadata {
    #[serde(default)]
    profiles: BTreeMap<String, ProfileMetadata>,
    #[serde(default)]
    enrolled_cards: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileMetadata {
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    description: Option<String>,
}

impl Default for ProfileMetadata {
    fn default() -> Self {
        Self {
            enabled: true,
            description: None,
        }
    }
}

fn default_enabled() -> bool {
    true
}

/// On-disk owner state. `registry` is the AwP interchange document verbatim;
/// `metadata` contains only Meshrix selection policy.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAgentState {
    version: u64,
    #[serde(default)]
    registry: RegistryDocument,
    #[serde(default)]
    metadata: HostMetadata,
}

impl StoredAgentState {
    fn empty() -> Self {
        Self {
            version: CURRENT_DOCUMENT_VERSION,
            ..Self::default()
        }
    }
}

/// A legacy document is read only by the one-time conversion path. No legacy
/// command model is used after conversion.
#[derive(Deserialize)]
struct LegacyAgentDocument {
    version: u64,
    agents: BTreeMap<String, LegacyAgentDefinition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAgentDefinition {
    #[serde(default)]
    id: Option<String>,
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: PathBuf,
    #[serde(default)]
    environment: BTreeMap<String, LegacyEnvironmentSource>,
    #[serde(default)]
    permission_policy: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LegacyEnvironmentSource {
    HostEnvironment { variable: String },
    SecretReference { reference: String },
    Literal { value: String },
}

/// Local A4AA/AwP registry plus the Peer execution-directory view.
pub struct FileAgentProfileRegistry {
    file_path: PathBuf,
    secret_resolver: Arc<dyn a4aa::SecretResolver>,
    state: RefCell<Option<StoredAgentState>>,
    registry: RefCell<Option<Rc<Registry>>>,
    detected: RefCell<Vec<DetectedAgent>>,
    file_mtime: RefCell<Option<std::time::SystemTime>>,
    write_lock: tokio::sync::Mutex<()>,
}

/// Read-only product availability. These rows are templates/discovery facts;
/// they are not stored Agents or Profiles until `enroll_card` is called.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCardAvailability {
    pub id: String,
    /// Stable profile selection id, including preserved pre-migration ids.
    pub profile_id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    pub supports_model: bool,
    pub supports_execution_mode: bool,
    pub supports_permission: bool,
    pub execution_modes: Vec<String>,
    pub permission_modes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_default: Option<String>,
    pub supports_effort: bool,
    pub model_catalog: AgentModelCatalog,
    pub callable: bool,
    pub enrolled: bool,
}

/// A4AA's model-enumeration route, without copying any agent model list.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentModelCatalog {
    None,
    RpcMethod { method: String },
    CliArgs { args: Vec<String> },
}

impl FileAgentProfileRegistry {
    /// `file_path` is the former `<agent-root>/agents.json`; successful v1
    /// conversion atomically replaces its contents with the AwP-backed form.
    pub fn new(
        file_path: PathBuf,
        secret_resolver: Arc<dyn a4aa::SecretResolver>,
    ) -> Result<Rc<Self>> {
        if file_path.as_os_str().is_empty() {
            return Err(store_error("An Agent profile registry file is required."));
        }
        let file_path = file_path
            .canonicalize()
            .unwrap_or_else(|_| file_path.to_path_buf());
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| {
                store_error("The Agent profile registry directory cannot be created.")
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
        let registry = Rc::new(Self {
            file_path,
            secret_resolver,
            state: RefCell::new(None),
            registry: RefCell::new(None),
            detected: RefCell::new(Vec::new()),
            file_mtime: RefCell::new(None),
            write_lock: tokio::sync::Mutex::new(()),
        });
        registry.refresh_discovery()?;
        Ok(registry)
    }

    /// Profiles currently saved in the AwP document.
    pub fn list_profiles(&self) -> Result<Vec<Profile>> {
        self.refresh_state()?;
        Ok(self
            .registry
            .borrow()
            .as_ref()
            .expect("registry refreshed")
            .profiles()
            .cloned()
            .collect())
    }

    /// AgentSpecs currently saved in the AwP document.
    pub fn list_agents(&self) -> Result<Vec<AgentSpec>> {
        self.refresh_state()?;
        Ok(self
            .registry
            .borrow()
            .as_ref()
            .expect("registry refreshed")
            .agents()
            .cloned()
            .collect())
    }

    /// A stable registry snapshot for one execution. The caller should retain
    /// this snapshot for the duration of that operation.
    pub fn awp_registry(&self) -> Rc<Registry> {
        self.registry
            .borrow()
            .as_ref()
            .expect("registry initialized by constructor")
            .clone()
    }

    /// A4AA product cards and local filesystem evidence, separate from saved
    /// AwP enrollment state.
    pub fn available_agent_cards(&self) -> Result<Vec<AgentCardAvailability>> {
        self.refresh_discovery()?;
        let state = self
            .state
            .borrow()
            .as_ref()
            .expect("state refreshed")
            .clone();
        let registry = self.awp_registry();
        Ok(self
            .detected
            .borrow()
            .iter()
            .map(|agent| {
                let features = agent.features();
                let session_support = agent.spec.selector_support(SelectorPhase::Session);
                let turn_support = agent.spec.selector_support(SelectorPhase::Turn);
                AgentCardAvailability {
                    id: agent.id().to_owned(),
                    profile_id: enrollment_profile_id(agent.id(), &registry),
                    display_name: agent.label().to_owned(),
                    detected: agent.evidence_label(),
                    transport: agent.callable().then(|| agent_transport(&agent.spec)),
                    supports_model: selector_is_supported(session_support.model)
                        || selector_is_supported(turn_support.model),
                    supports_execution_mode: selector_is_supported(session_support.mode)
                        && !features.execution_modes.is_empty(),
                    supports_permission: selector_is_supported(session_support.permission)
                        && !features.permission_modes.is_empty(),
                    execution_modes: features
                        .execution_modes
                        .iter()
                        .map(|mode| (*mode).to_owned())
                        .collect(),
                    permission_modes: features
                        .permission_modes
                        .iter()
                        .map(|mode| (*mode).to_owned())
                        .collect(),
                    permission_default: features.permission_default.map(str::to_owned),
                    supports_effort: (selector_is_supported(session_support.effort)
                        || selector_is_supported(turn_support.effort))
                        && features.effort,
                    model_catalog: match features.models {
                        ModelCatalog::None => AgentModelCatalog::None,
                        ModelCatalog::RpcMethod(method) => AgentModelCatalog::RpcMethod {
                            method: method.to_owned(),
                        },
                        ModelCatalog::CliArgs(args) => AgentModelCatalog::CliArgs {
                            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
                        },
                    },
                    callable: agent.callable(),
                    enrolled: state.metadata.enrolled_cards.contains(agent.id())
                        || state.registry.agents.contains_key(agent.id()),
                }
            })
            .collect())
    }

    /// Explicitly enroll one maintained A4AA card as an AwP AgentSpec and
    /// named default Profile. Merely detecting a card never writes user state.
    pub async fn enroll_card(&self, card_id: &str) -> Result<Profile> {
        self.mutate(|state, registry| {
            let candidate = self
                .detected
                .borrow()
                .iter()
                .find(|agent| agent.id() == card_id)
                .cloned()
                .ok_or_else(agent_error)?;
            let mut next_state = state.clone();
            if next_state.registry.agents.contains_key(card_id)
                && !next_state.metadata.enrolled_cards.contains(card_id)
            {
                return Err(agent_error());
            }
            let profile_id = enrollment_profile_id(card_id, registry);
            if let Some(profile) = registry.profile(&profile_id) {
                if profile.agent != card_id {
                    return Err(profile_error());
                }
                next_state
                    .metadata
                    .enrolled_cards
                    .insert(card_id.to_owned());
                next_state.registry.agents.insert(
                    card_id.to_owned(),
                    AgentEntry {
                        spec: candidate.spec,
                        alternates: candidate.alternates,
                    },
                );
                return Ok((next_state, profile.clone()));
            }
            let mut next_registry = registry.clone();
            let display_name = candidate.label().to_owned();
            let entry = AgentEntry {
                spec: candidate.spec.clone(),
                alternates: candidate.alternates.clone(),
            };
            next_registry
                .apply(RegistryDocument {
                    agents: BTreeMap::from([(card_id.to_owned(), entry.clone())]),
                    profiles: BTreeMap::from([(
                        profile_id.clone(),
                        ProfilePatch {
                            name: Some(display_name),
                            agent: Some(card_id.to_owned()),
                            ..ProfilePatch::default()
                        },
                    )]),
                    ..RegistryDocument::default()
                })
                .map_err(|_| profile_error())?;
            let profile = next_registry
                .profile(&profile_id)
                .cloned()
                .ok_or_else(profile_error)?;
            next_state.registry.agents.insert(card_id.to_owned(), entry);
            next_state
                .registry
                .profiles
                .insert(profile_id.clone(), profile.to_patch());
            next_state.metadata.profiles.entry(profile_id).or_default();
            next_state
                .metadata
                .enrolled_cards
                .insert(card_id.to_owned());
            Ok((next_state, profile))
        })
        .await
    }

    /// Apply an AwP profile patch and persist the AwP-resolved profile. AwP
    /// performs field merging and validation before the atomic write.
    pub async fn upsert_profile(&self, id: &str, patch: ProfilePatch) -> Result<Profile> {
        if !valid_agent_id(id) {
            return Err(profile_error());
        }
        self.mutate(|state, registry| {
            let mut next_state = state.clone();
            let mut next_registry = registry.clone();
            let mut profiles = BTreeMap::new();
            profiles.insert(id.to_owned(), patch);
            next_registry
                .apply(RegistryDocument {
                    profiles,
                    ..RegistryDocument::default()
                })
                .map_err(|_| profile_error())?;
            let profile = next_registry
                .profile(id)
                .cloned()
                .ok_or_else(profile_error)?;
            let spec = next_registry
                .agent(&profile.agent)
                .ok_or_else(profile_error)?;
            validate_profile_capabilities(&profile, spec)?;
            next_state
                .registry
                .profiles
                .insert(id.to_owned(), profile.to_patch());
            next_state
                .metadata
                .profiles
                .entry(id.to_owned())
                .or_default();
            Ok((next_state, profile))
        })
        .await
    }

    pub async fn remove_profile(&self, id: &str) -> Result<bool> {
        self.mutate(|state, registry| {
            if registry.profile(id).is_none() {
                return Ok((state.clone(), false));
            }
            let mut next_state = state.clone();
            next_state.registry.profiles.remove(id);
            next_state.metadata.profiles.remove(id);
            next_state
                .registry
                .bindings
                .retain(|_, binding| binding.profile() != id);
            Ok((next_state, true))
        })
        .await
    }

    pub async fn set_profile_enabled(&self, id: &str, enabled: bool) -> Result<bool> {
        self.mutate(|state, registry| {
            if registry.profile(id).is_none() {
                return Ok((state.clone(), false));
            }
            let mut next_state = state.clone();
            next_state
                .metadata
                .profiles
                .entry(id.to_owned())
                .or_default()
                .enabled = enabled;
            Ok((next_state, true))
        })
        .await
    }

    /// Enroll a generic AgentSpec. A4AA product-card identifiers are reserved
    /// for their maintained descriptors.
    pub async fn register_agent(&self, spec: AgentSpec) -> Result<AgentSpec> {
        self.mutate(|state, registry| {
            if !valid_agent_spec(&spec) || a4aa_dialects::card(&spec.id).is_some() {
                return Err(agent_error());
            }
            if registry.agent(&spec.id).is_some() {
                return Err(agent_error());
            }
            let mut next_state = state.clone();
            let id = spec.id.clone();
            next_state
                .registry
                .agents
                .insert(id.clone(), AgentEntry::single(spec.clone()));
            Ok((next_state, spec))
        })
        .await
    }

    pub async fn update_agent(&self, id: &str, spec: AgentSpec) -> Result<AgentSpec> {
        self.mutate(|state, registry| {
            if id != spec.id
                || !valid_agent_spec(&spec)
                || a4aa_dialects::card(id).is_some()
                || state.metadata.enrolled_cards.contains(id)
            {
                return Err(agent_error());
            }
            if !state.registry.agents.contains_key(id) || registry.agent(id).is_none() {
                return Err(agent_error());
            }
            let mut next_state = state.clone();
            // Updating the primary spec must not silently discard AwP lane
            // alternates already present in an imported registry document.
            next_state
                .registry
                .agents
                .get_mut(id)
                .ok_or_else(agent_error)?
                .spec = spec.clone();
            Ok((next_state, spec))
        })
        .await
    }

    pub async fn remove_agent(&self, id: &str) -> Result<bool> {
        self.mutate(|state, registry| {
            if !state.registry.agents.contains_key(id)
                || (a4aa_dialects::card(id).is_some()
                    && !state.metadata.enrolled_cards.contains(id))
            {
                return Ok((state.clone(), false));
            }
            let mut next_state = state.clone();
            next_state.registry.agents.remove(id);
            next_state.metadata.enrolled_cards.remove(id);
            let profile_ids: Vec<String> = registry
                .profiles()
                .filter(|profile| profile.agent == id)
                .map(|profile| profile.id.clone())
                .collect();
            for profile_id in profile_ids {
                next_state.registry.profiles.remove(&profile_id);
                next_state.metadata.profiles.remove(&profile_id);
                next_state
                    .registry
                    .bindings
                    .retain(|_, binding| binding.profile() != profile_id);
            }
            Ok((next_state, true))
        })
        .await
    }

    fn refresh_discovery(&self) -> Result<()> {
        self.refresh_state()?;
        *self.detected.borrow_mut() = detect::scan_local_agents();
        Ok(())
    }

    fn refresh_state(&self) -> Result<()> {
        let disk_mtime = std::fs::metadata(&self.file_path)
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        let changed = self.state.borrow().is_none() || disk_mtime != *self.file_mtime.borrow();
        let (state, migrate_legacy) = if changed {
            self.read_state()?
        } else {
            (
                self.state.borrow().as_ref().expect("state loaded").clone(),
                false,
            )
        };
        let registry = build_awp_registry(&state)?;
        if migrate_legacy {
            self.write_state(&state)?;
        }
        if changed {
            *self.file_mtime.borrow_mut() = std::fs::metadata(&self.file_path)
                .ok()
                .and_then(|metadata| metadata.modified().ok());
        }
        *self.state.borrow_mut() = Some(state);
        *self.registry.borrow_mut() = Some(Rc::new(registry));
        Ok(())
    }

    fn read_state(&self) -> Result<(StoredAgentState, bool)> {
        let text = match std::fs::read_to_string(&self.file_path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((StoredAgentState::empty(), false));
            }
            Err(_) => return Err(store_error("The Agent profile registry cannot be read.")),
        };
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| store_error("The Agent profile registry is malformed."))?;
        match value.get("version").and_then(serde_json::Value::as_u64) {
            Some(1) => {
                let legacy: LegacyAgentDocument = serde_json::from_value(value)
                    .map_err(|_| store_error("The saved Agent enrollments are malformed."))?;
                if legacy.version != 1 {
                    return Err(store_error("The saved Agent enrollments are unsupported."));
                }
                Ok((convert_legacy_document(legacy)?, true))
            }
            Some(CURRENT_DOCUMENT_VERSION) => {
                let state: StoredAgentState = serde_json::from_value(value)
                    .map_err(|_| store_error("The Agent profile registry is malformed."))?;
                if state.version != CURRENT_DOCUMENT_VERSION {
                    return Err(store_error("The Agent profile registry is unsupported."));
                }
                Ok((state, false))
            }
            _ => Err(store_error(
                "The Agent profile registry version is unsupported.",
            )),
        }
    }

    async fn mutate<T>(
        &self,
        operation: impl FnOnce(&StoredAgentState, &Registry) -> Result<(StoredAgentState, T)>,
    ) -> Result<T> {
        let _guard = self.write_lock.lock().await;
        self.refresh_state()?;
        let state = self
            .state
            .borrow()
            .as_ref()
            .expect("state refreshed")
            .clone();
        let registry = self
            .registry
            .borrow()
            .as_ref()
            .expect("registry refreshed")
            .as_ref()
            .clone();
        let (mut next_state, output) = operation(&state, &registry)?;
        next_state.version = CURRENT_DOCUMENT_VERSION;
        if next_state == state {
            return Ok(output);
        }
        let next_registry = build_awp_registry(&next_state)?;
        self.write_state(&next_state)?;
        *self.file_mtime.borrow_mut() = std::fs::metadata(&self.file_path)
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        *self.state.borrow_mut() = Some(next_state);
        *self.registry.borrow_mut() = Some(Rc::new(next_registry));
        Ok(output)
    }

    fn write_state(&self, state: &StoredAgentState) -> Result<()> {
        let text = format!(
            "{}\n",
            serde_json::to_string(state)
                .map_err(|_| store_error("The Agent profile registry cannot be encoded."))?
        );
        write_private_file_atomic(&self.file_path, text.as_bytes())
    }

    fn summary(
        &self,
        profile: &Profile,
        registry: &Registry,
        state: &StoredAgentState,
        detected: &[DetectedAgent],
    ) -> AcpAgentSummary {
        let agent_spec = registry.agent(&profile.agent);
        let agent_detection = detected
            .iter()
            .find(|candidate| candidate.id() == profile.agent);
        let is_enrolled_card = state.metadata.enrolled_cards.contains(&profile.agent);
        let profile_metadata = state.metadata.profiles.get(&profile.id);
        let display_name = if profile.name.trim().is_empty() {
            agent_spec
                .and_then(|spec| spec.client_name.as_deref())
                .unwrap_or(&profile.agent)
                .to_owned()
        } else {
            profile.name.clone()
        };
        let callable = if is_enrolled_card {
            agent_detection.is_some_and(DetectedAgent::callable)
        } else {
            agent_spec.is_some()
        };
        AcpAgentSummary {
            id: profile.id.clone(),
            display_name,
            description: profile_metadata.and_then(|metadata| metadata.description.clone()),
            enabled: profile_metadata.map_or(true, |metadata| metadata.enabled),
            detected: agent_detection.and_then(DetectedAgent::evidence_label),
            transport: if callable {
                agent_spec.map(agent_transport)
            } else {
                None
            },
        }
    }
}

impl PeerApplicationAgentDirectory for FileAgentProfileRegistry {
    fn list(&self) -> LocalBoxFuture<'_, Result<Vec<AcpAgentSummary>>> {
        Box::pin(async move {
            self.refresh_discovery()?;
            let state = self
                .state
                .borrow()
                .as_ref()
                .expect("state refreshed")
                .clone();
            let registry = self
                .registry
                .borrow()
                .as_ref()
                .expect("registry refreshed")
                .clone();
            let detected = self.detected.borrow().clone();
            let mut summaries = Vec::new();
            for profile in registry.profiles() {
                summaries.push(self.summary(profile, &registry, &state, &detected));
            }
            Ok(summaries)
        })
    }

    fn get(&self, profile_id: &str) -> Option<Rc<dyn PeerApplicationAgentExecutor>> {
        self.refresh_state().ok()?;
        let state = self.state.borrow().as_ref()?.clone();
        let registry = self.registry.borrow().as_ref()?.clone();
        let profile = registry.profile(profile_id)?.clone();
        let metadata = state.metadata.profiles.get(profile_id);
        if metadata.is_some_and(|metadata| !metadata.enabled) {
            return None;
        }
        let _spec = registry.agent(&profile.agent)?;
        if state.metadata.enrolled_cards.contains(&profile.agent)
            && !self
                .detected
                .borrow()
                .iter()
                .find(|candidate| candidate.id() == profile.agent)
                .is_some_and(DetectedAgent::callable)
        {
            return None;
        }
        let summary = self.summary(&profile, &registry, &state, &self.detected.borrow());
        let executor = ProfiledAgentExecutor::new(
            summary,
            registry,
            profile_id.to_owned(),
            self.secret_resolver.clone(),
        );
        Some(Rc::new(executor))
    }
}

fn build_awp_registry(state: &StoredAgentState) -> Result<Registry> {
    let registry = Registry::from_document(state.registry.clone())
        .map_err(|_| store_error("The saved AwP Agent profiles are invalid."))?;
    for profile in registry.profiles() {
        let spec = registry
            .agent(&profile.agent)
            .ok_or_else(|| store_error("A saved AwP profile has no AgentSpec."))?;
        validate_profile_capabilities(profile, spec)
            .map_err(|_| store_error("A saved AwP profile uses unsupported Agent features."))?;
    }
    Ok(registry)
}

fn validate_profile_capabilities(profile: &Profile, spec: &AgentSpec) -> Result<()> {
    if profile.mechanisms.is_some() {
        return Err(profile_error());
    }
    if !profile.mcp_servers.is_empty() && !matches!(&spec.lane, LaneSpec::Acp { .. }) {
        return Err(profile_error());
    }
    if [
        profile.model.as_deref(),
        profile.effort.as_deref(),
        profile.mode.as_deref(),
        profile.permission.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|selector| selector.trim().is_empty())
    {
        return Err(profile_error());
    }
    let session_support = spec.selector_support(SelectorPhase::Session);
    let turn_support = spec.selector_support(SelectorPhase::Turn);
    if profile.model.is_some()
        && !selector_is_supported(session_support.model)
        && !selector_is_supported(turn_support.model)
    {
        return Err(profile_error());
    }
    if profile.effort.is_some()
        && ((!selector_is_supported(session_support.effort)
            && !selector_is_supported(turn_support.effort))
            || a4aa_dialects::card(&profile.agent).is_some_and(|card| !card.features.effort))
    {
        return Err(profile_error());
    }
    if profile.mode.as_deref().is_some_and(|mode| {
        !selector_is_supported(session_support.mode) || !mode_value_allowed(spec, mode)
    }) {
        return Err(profile_error());
    }
    if profile.permission.as_deref().is_some_and(|permission| {
        !selector_is_supported(session_support.permission)
            || !permission_value_allowed(spec, permission)
    }) {
        return Err(profile_error());
    }
    Ok(())
}

fn selector_is_supported(support: SelectorSupport) -> bool {
    matches!(
        support,
        SelectorSupport::Applied | SelectorSupport::Negotiated
    )
}

fn mode_value_allowed(spec: &AgentSpec, value: &str) -> bool {
    if let Some(card) = a4aa_dialects::card(&spec.id) {
        return card.features.execution_modes.contains(&value);
    }
    match &spec.lane {
        LaneSpec::Cli(lane) => lane.execution_modes.iter().any(|mode| mode == value),
        // ACP validates its dynamically advertised options during session
        // setup. Generic RPC and serve lanes have no maintained mode-value
        // allowlist.
        LaneSpec::Acp { .. } => true,
        LaneSpec::Rpc(_) | LaneSpec::Serve { .. } => false,
    }
}

fn permission_value_allowed(spec: &AgentSpec, value: &str) -> bool {
    if let Some(card) = a4aa_dialects::card(&spec.id) {
        return card.features.permission_modes.contains(&value);
    }
    match &spec.lane {
        LaneSpec::Cli(lane) => lane.permission_modes.iter().any(|mode| mode == value),
        // ACP validates its dynamically advertised options during session
        // setup. Serve negotiates permission against its injected configuration.
        // Generic RPC has no maintained permission-value allowlist.
        LaneSpec::Acp { .. } | LaneSpec::Serve { .. } => true,
        LaneSpec::Rpc(_) => false,
    }
}

fn convert_legacy_document(document: LegacyAgentDocument) -> Result<StoredAgentState> {
    if document.version != 1 {
        return Err(store_error("The saved Agent enrollments are unsupported."));
    }
    let mut state = StoredAgentState::empty();
    for (id, legacy) in document.agents {
        if legacy
            .id
            .as_deref()
            .is_some_and(|stored_id| stored_id != id)
            || !valid_agent_id(&id)
            || legacy.display_name.trim().is_empty()
            || legacy.display_name.len() > 256
            || legacy.command.trim().is_empty()
            || legacy.command.len() > 2048
            || legacy.args.iter().any(|argument| argument.len() > 8192)
            || !legacy.cwd.is_absolute()
            || legacy
                .description
                .as_ref()
                .is_some_and(|description| description.len() > 2048)
            || legacy
                .permission_policy
                .as_deref()
                .is_some_and(|policy| policy != "ask")
        {
            return Err(store_error("A saved Agent enrollment is invalid."));
        }
        let mut environment = BTreeMap::new();
        for (name, source) in legacy.environment {
            if !valid_environment_name(&name) {
                return Err(store_error("A saved Agent environment mapping is invalid."));
            }
            let source = match source {
                LegacyEnvironmentSource::HostEnvironment { variable } => {
                    if !valid_environment_name(&variable) {
                        return Err(store_error(
                            "A saved Agent environment reference is invalid.",
                        ));
                    }
                    EnvValue::Source(EnvSource::HostEnv { host_env: variable })
                }
                LegacyEnvironmentSource::SecretReference { reference } => {
                    if !valid_secret_reference(&reference) {
                        return Err(store_error("A saved Agent secret reference is invalid."));
                    }
                    EnvValue::Source(EnvSource::Secret { secret: reference })
                }
                LegacyEnvironmentSource::Literal { value } => {
                    if value.is_empty() {
                        return Err(store_error("A saved Agent environment value is invalid."));
                    }
                    EnvValue::Literal(value)
                }
            };
            environment.insert(name, source);
        }
        let spec = AgentSpec {
            id: id.clone(),
            client_name: None,
            lane: LaneSpec::Acp {
                mcp_servers: Vec::new(),
                prefer_load: true,
                auth_key: None,
            },
            command: CommandSpec {
                program: legacy.command,
                args: legacy.args,
                cwd: Some(legacy.cwd),
                env: EnvPolicy::Sanitized {
                    inherit: Vec::new(),
                    set: environment,
                },
            },
            max_output_bytes: None,
        };
        state
            .registry
            .agents
            .insert(id.clone(), AgentEntry::single(spec));
        let profile_name = legacy.display_name.trim().to_owned();
        state.registry.profiles.insert(
            id.clone(),
            ProfilePatch {
                name: Some(profile_name),
                agent: Some(id.clone()),
                ..ProfilePatch::default()
            },
        );
        state.metadata.profiles.insert(
            id,
            ProfileMetadata {
                enabled: legacy.enabled.unwrap_or(true),
                description: legacy
                    .description
                    .map(|description| description.trim().to_owned())
                    .filter(|description| !description.is_empty()),
            },
        );
    }
    Ok(state)
}

fn default_profile_id(agent_id: &str) -> String {
    // This one rename preserves the pre-A4AA Claude Code targetAgentId.
    if agent_id == "claude" {
        "agent.claude-code".to_owned()
    } else {
        format!("agent.{agent_id}")
    }
}

fn available_profile_id(agent_id: &str, registry: &Registry) -> String {
    let preserved = default_profile_id(agent_id);
    if registry.profile(&preserved).is_none() {
        return preserved;
    }
    let mut candidate = format!("{preserved}.default");
    let mut suffix = 2;
    while registry.profile(&candidate).is_some() {
        candidate = format!("{preserved}.default.{suffix}");
        suffix += 1;
    }
    candidate
}

fn enrollment_profile_id(agent_id: &str, registry: &Registry) -> String {
    let preserved = default_profile_id(agent_id);
    if registry
        .profile(&preserved)
        .is_some_and(|profile| profile.agent == agent_id)
    {
        return preserved;
    }
    available_profile_id(agent_id, registry)
}

fn valid_agent_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && (2..=128).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn valid_agent_spec(spec: &AgentSpec) -> bool {
    valid_agent_id(&spec.id) && !spec.command.program.trim().is_empty()
}

fn valid_environment_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn valid_secret_reference(reference: &str) -> bool {
    let mut chars = reference.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && reference.len() <= 251
        && reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn agent_transport(spec: &AgentSpec) -> String {
    match &spec.lane {
        LaneSpec::Acp { .. } => "acp".to_owned(),
        LaneSpec::Rpc(_) => "rpc".to_owned(),
        LaneSpec::Cli(_) => "cli".to_owned(),
        LaneSpec::Serve { .. } => "serve".to_owned(),
    }
}

fn agent_error() -> crate::EntryError {
    entry_error(
        "agent_definition_invalid",
        "The Agent definition is invalid.",
    )
}

fn profile_error() -> crate::EntryError {
    entry_error("agent_profile_invalid", "The Agent profile is invalid.")
}

fn store_error(detail: &str) -> crate::EntryError {
    entry_error("agent_store_error", detail)
}

fn write_private_file_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    crate::peer::store::atomic_write(path, bytes)
        .map_err(|_| store_error("The Agent profile registry could not be written."))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct EmptySecrets;

    #[async_trait::async_trait]
    impl a4aa::SecretResolver for EmptySecrets {
        async fn resolve(&self, _reference: &str) -> Option<String> {
            None
        }
    }

    fn temp_registry() -> (tempfile::TempDir, Rc<FileAgentProfileRegistry>) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agents.json");
        let registry = FileAgentProfileRegistry::new(path, Arc::new(EmptySecrets)).unwrap();
        (temp, registry)
    }

    fn generic_cli_spec(id: &str, args: &[&str]) -> AgentSpec {
        let mut lane = a4aa::CliLaneSpec::default();
        lane.args = args.iter().map(|argument| (*argument).to_owned()).collect();
        lane.prompt_channel = a4aa::PromptChannel::ArgOnly;
        AgentSpec {
            id: id.to_owned(),
            client_name: None,
            lane: LaneSpec::Cli(Box::new(lane)),
            command: CommandSpec {
                program: "generic-agent".to_owned(),
                ..CommandSpec::default()
            },
            max_output_bytes: None,
        }
    }

    #[tokio::test]
    async fn updating_primary_spec_preserves_saved_awp_alternates() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agents.json");
        let primary = generic_cli_spec("custom.alternate", &["{prompt}"]);
        let mut alternate = primary.clone();
        alternate.command.program = "alternate-agent".to_owned();
        let mut state = StoredAgentState::empty();
        state.registry.agents.insert(
            primary.id.clone(),
            awp::AgentEntry {
                spec: primary.clone(),
                alternates: vec![alternate.clone()],
            },
        );
        std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
        let registry = FileAgentProfileRegistry::new(path.clone(), Arc::new(EmptySecrets)).unwrap();
        let mut updated = primary.clone();
        updated.command.program = "updated-agent".to_owned();
        registry
            .update_agent(&primary.id, updated.clone())
            .await
            .unwrap();
        let saved: StoredAgentState =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved.registry.agents[&primary.id].spec, updated);
        assert_eq!(
            saved.registry.agents[&primary.id].alternates,
            vec![alternate]
        );
    }

    #[test]
    fn public_awp_agent_entry_preserves_the_flat_saved_spec_shape() {
        let spec = generic_cli_spec("custom.saved", &["{prompt}"]);
        let value = serde_json::to_value(&spec).unwrap();
        let entry: awp::AgentEntry = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(entry.spec, spec);
        assert!(entry.alternates.is_empty());
        assert_eq!(serde_json::to_value(entry).unwrap(), value);
    }

    #[test]
    fn serve_lane_has_explicit_transport_and_selector_boundaries() {
        let mut spec = generic_cli_spec("custom.serve", &[]);
        spec.lane = LaneSpec::Serve {
            mcp_servers: vec![],
        };
        assert_eq!(agent_transport(&spec), "serve");
        let mut profile = Profile {
            id: "profile.serve".to_owned(),
            agent: spec.id.clone(),
            model: Some("model-x".to_owned()),
            permission: Some("read-only".to_owned()),
            ..Profile::default()
        };
        // A4AA negotiates permission at session establishment; it does not
        // advertise mode or effort support for the Serve lane.
        assert!(validate_profile_capabilities(&profile, &spec).is_ok());
        profile.mode = Some("plan".to_owned());
        assert!(validate_profile_capabilities(&profile, &spec).is_err());
        profile.mode = None;
        profile.effort = Some("high".to_owned());
        assert!(validate_profile_capabilities(&profile, &spec).is_err());
    }

    #[test]
    fn default_profile_ids_preserve_existing_peer_selections() {
        assert_eq!(default_profile_id("claude"), "agent.claude-code");
        assert_eq!(default_profile_id("codex"), "agent.codex");
        assert_eq!(default_profile_id("opencode"), "agent.opencode");
        assert_eq!(default_profile_id("pi"), "agent.pi");
    }

    #[test]
    fn empty_registry_does_not_save_card_templates_as_agents_or_profiles() {
        let state = StoredAgentState::empty();
        let registry = build_awp_registry(&state).unwrap();
        assert_eq!(registry.agents().len(), 0);
        assert_eq!(registry.profiles().len(), 0);
    }

    #[tokio::test]
    async fn card_is_materialized_only_by_explicit_enrollment() {
        let (temp, registry) = temp_registry();
        assert!(registry.list_agents().unwrap().is_empty());
        assert!(registry.list_profiles().unwrap().is_empty());
        let cards = registry.available_agent_cards().unwrap();
        assert!(cards.iter().any(|card| card.id == "codex"));
        let antigravity = cards.iter().find(|card| card.id == "antigravity").unwrap();
        assert!(antigravity.permission_modes.is_empty());
        assert_eq!(antigravity.permission_default, None);
        assert!(!temp.path().join("agents.json").exists());
        let profile = registry.enroll_card("codex").await.unwrap();
        assert_eq!(profile.id, "agent.codex");
        assert_eq!(profile.agent, "codex");
        assert_eq!(registry.list_agents().unwrap().len(), 1);
        assert_eq!(registry.list_profiles().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn antigravity_rejects_unsupported_permission_mode_without_saving_it() {
        let (_temp, registry) = temp_registry();
        let profile = registry.enroll_card("antigravity").await.unwrap();
        let result = registry
            .upsert_profile(
                &profile.id,
                ProfilePatch {
                    permission: Some("allow-all".to_owned()),
                    ..ProfilePatch::default()
                },
            )
            .await;
        assert!(result.is_err());
        assert!(registry
            .list_profiles()
            .unwrap()
            .iter()
            .find(|saved| saved.id == profile.id)
            .unwrap()
            .permission
            .is_none());
    }

    #[tokio::test]
    async fn generic_agent_profile_selectors_follow_a4aa_lane_templates() {
        let (_temp, registry) = temp_registry();
        registry
            .register_agent(generic_cli_spec(
                "custom.agent",
                &["--model", "{model}", "--effort", "{effort}", "{prompt}"],
            ))
            .await
            .unwrap();
        let profile = registry
            .upsert_profile(
                "profile.custom",
                ProfilePatch {
                    name: Some("Custom".to_owned()),
                    agent: Some("custom.agent".to_owned()),
                    model: Some("model-x".to_owned()),
                    effort: Some("high".to_owned()),
                    ..ProfilePatch::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(profile.model.as_deref(), Some("model-x"));
        assert_eq!(profile.effort.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn generic_rpc_profile_defaults_may_use_session_configuration() {
        let (_temp, registry) = temp_registry();
        let mut lane = a4aa::RpcLaneSpec::default();
        lane.session_open = Some(a4aa::RpcCallSpec {
            method: "session/open".to_owned(),
            params: serde_json::json!({"model":"{model}","effort":"{effort}"}),
        });
        lane.prompt = a4aa::RpcCallSpec {
            method: "turn".to_owned(),
            params: serde_json::json!({"prompt":"{prompt}"}),
        };
        let spec = AgentSpec {
            id: "custom.rpc".to_owned(),
            client_name: None,
            lane: LaneSpec::Rpc(Box::new(lane)),
            command: CommandSpec {
                program: "custom-rpc".to_owned(),
                ..CommandSpec::default()
            },
            max_output_bytes: None,
        };
        let support = spec.selector_support(SelectorPhase::Session);
        assert_eq!(support.model, SelectorSupport::Applied);
        assert_eq!(support.effort, SelectorSupport::Applied);
        assert_eq!(
            spec.selector_support(SelectorPhase::Turn).model,
            SelectorSupport::Unsupported
        );
        registry.register_agent(spec).await.unwrap();
        let profile = registry
            .upsert_profile(
                "profile.rpc",
                ProfilePatch {
                    agent: Some("custom.rpc".to_owned()),
                    model: Some("model-x".to_owned()),
                    effort: Some("high".to_owned()),
                    ..ProfilePatch::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(profile.model.as_deref(), Some("model-x"));
        assert_eq!(profile.effort.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn generic_agent_rejects_model_default_when_lane_does_not_apply_it() {
        let (_temp, registry) = temp_registry();
        registry
            .register_agent(generic_cli_spec("custom.agent", &["{prompt}"]))
            .await
            .unwrap();
        let result = registry
            .upsert_profile(
                "profile.custom",
                ProfilePatch {
                    agent: Some("custom.agent".to_owned()),
                    model: Some("model-x".to_owned()),
                    ..ProfilePatch::default()
                },
            )
            .await;
        assert!(result.is_err());
        assert!(registry.list_profiles().unwrap().is_empty());
    }

    #[tokio::test]
    async fn generic_agent_mode_and_permission_use_a4aa_lane_allowlists() {
        let (_temp, registry) = temp_registry();
        let mut spec = generic_cli_spec(
            "custom.agent",
            &[
                "--mode",
                "{mode}",
                "--permission",
                "{permission}",
                "{prompt}",
            ],
        );
        let LaneSpec::Cli(lane) = &mut spec.lane else {
            unreachable!()
        };
        lane.execution_modes = vec!["plan".to_owned()];
        lane.permission_modes = vec!["ask".to_owned()];
        registry.register_agent(spec).await.unwrap();
        let profile = registry
            .upsert_profile(
                "profile.custom",
                ProfilePatch {
                    agent: Some("custom.agent".to_owned()),
                    mode: Some("plan".to_owned()),
                    permission: Some("ask".to_owned()),
                    ..ProfilePatch::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(profile.mode.as_deref(), Some("plan"));
        assert_eq!(profile.permission.as_deref(), Some("ask"));

        let invalid = registry
            .upsert_profile(
                "profile.custom",
                ProfilePatch {
                    mode: Some("unlisted".to_owned()),
                    ..ProfilePatch::default()
                },
            )
            .await;
        assert!(invalid.is_err());
        let saved = registry
            .list_profiles()
            .unwrap()
            .into_iter()
            .find(|saved| saved.id == "profile.custom")
            .unwrap();
        assert_eq!(saved.mode.as_deref(), Some("plan"));
    }

    #[tokio::test]
    async fn generic_acp_profile_selectors_defer_to_runtime_negotiation() {
        let (_temp, registry) = temp_registry();
        registry
            .register_agent(AgentSpec {
                id: "custom.acp".to_owned(),
                client_name: None,
                lane: LaneSpec::Acp {
                    mcp_servers: Vec::new(),
                    prefer_load: false,
                    auth_key: None,
                },
                command: CommandSpec {
                    program: "custom-acp".to_owned(),
                    ..CommandSpec::default()
                },
                max_output_bytes: None,
            })
            .await
            .unwrap();
        let profile = registry
            .upsert_profile(
                "profile.acp",
                ProfilePatch {
                    agent: Some("custom.acp".to_owned()),
                    model: Some("model-x".to_owned()),
                    effort: Some("high".to_owned()),
                    mode: Some("plan".to_owned()),
                    permission: Some("ask".to_owned()),
                    ..ProfilePatch::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(profile.model.as_deref(), Some("model-x"));
        assert_eq!(profile.effort.as_deref(), Some("high"));
        assert_eq!(profile.mode.as_deref(), Some("plan"));
        assert_eq!(profile.permission.as_deref(), Some("ask"));
    }

    #[test]
    fn unsupported_profile_execution_surfaces_fail_closed() {
        let card = a4aa_dialects::card("antigravity").unwrap();
        let spec = card.spec();
        let mut profile = Profile {
            id: "agent.antigravity".to_owned(),
            agent: "antigravity".to_owned(),
            permission: Some("not-a-card-mode".to_owned()),
            ..Profile::default()
        };
        assert!(validate_profile_capabilities(&profile, &spec).is_err());
        profile.permission = None;
        profile.mode = Some("not-a-card-mode".to_owned());
        assert!(validate_profile_capabilities(&profile, &spec).is_err());
        profile.mode = None;
        profile.mechanisms = Some(a4aa::MechanismSet::default());
        assert!(validate_profile_capabilities(&profile, &spec).is_err());
        profile.mechanisms = None;
        profile
            .mcp_servers
            .push(serde_json::json!({"name":"local"}));
        assert!(validate_profile_capabilities(&profile, &spec).is_ok());
        let cli_spec = card
            .specs()
            .into_iter()
            .find(|candidate| matches!(candidate.lane, LaneSpec::Cli(_)))
            .expect("the card keeps its CLI alternate");
        assert!(validate_profile_capabilities(&profile, &cli_spec).is_err());
    }

    #[tokio::test]
    async fn legacy_enrollments_convert_atomically_and_keep_ids_and_secret_refs() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agents.json");
        let legacy = serde_json::json!({
            "version": 1,
            "agents": {
                "agent.custom": {
                    "id": "agent.custom",
                    "displayName": "Custom Agent",
                    "description": "Local setup",
                    "command": "custom-agent",
                    "args": ["--stdio"],
                    "cwd": temp.path().to_string_lossy(),
                    "environment": {
                        "API_TOKEN": {"kind": "secret_reference", "reference": "custody.custom"},
                        "CONFIG_HOME": {"kind": "host_environment", "variable": "HOME"}
                    },
                    "permissionPolicy": "ask",
                    "enabled": false
                }
            }
        });
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let registry = FileAgentProfileRegistry::new(path.clone(), Arc::new(EmptySecrets)).unwrap();
        let profile = registry
            .list_profiles()
            .unwrap()
            .into_iter()
            .find(|profile| profile.id == "agent.custom")
            .unwrap();
        assert_eq!(profile.agent, "agent.custom");
        let converted = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&converted).unwrap();
        assert_eq!(value["version"], CURRENT_DOCUMENT_VERSION);
        let persisted: StoredAgentState = serde_json::from_value(value).unwrap();
        let spec = &persisted.registry.agents["agent.custom"].spec;
        let EnvPolicy::Sanitized { set, .. } = &spec.command.env else {
            panic!("legacy environment remains sanitized")
        };
        assert_eq!(
            set["API_TOKEN"],
            EnvValue::Source(EnvSource::Secret {
                secret: "custody.custom".to_owned()
            })
        );
        let summary = registry
            .list()
            .await
            .unwrap()
            .into_iter()
            .find(|summary| summary.id == "agent.custom")
            .unwrap();
        assert!(!summary.enabled);
    }

    #[tokio::test]
    async fn profile_updates_use_awp_merge_and_enabled_metadata_is_separate() {
        let (_temp, registry) = temp_registry();
        registry.enroll_card("codex").await.unwrap();
        let profile = registry
            .upsert_profile(
                "agent.codex",
                ProfilePatch {
                    model: Some("model-x".into()),
                    ..ProfilePatch::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(profile.agent, "codex");
        assert_eq!(profile.model.as_deref(), Some("model-x"));
        let updated = registry
            .upsert_profile(
                "agent.codex",
                ProfilePatch {
                    effort: Some("high".into()),
                    ..ProfilePatch::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.model.as_deref(), Some("model-x"));
        assert_eq!(updated.effort.as_deref(), Some("high"));
        assert!(registry
            .set_profile_enabled("agent.codex", false)
            .await
            .unwrap());
        let summary = registry
            .list()
            .await
            .unwrap()
            .into_iter()
            .find(|summary| summary.id == "agent.codex")
            .unwrap();
        assert!(!summary.enabled);
    }

    #[tokio::test]
    async fn removing_default_profile_keeps_it_removed_after_reload() {
        let (temp, registry) = temp_registry();
        registry.enroll_card("codex").await.unwrap();
        assert!(registry.remove_profile("agent.codex").await.unwrap());
        drop(registry);
        let reloaded =
            FileAgentProfileRegistry::new(temp.path().join("agents.json"), Arc::new(EmptySecrets))
                .unwrap();
        assert!(!reloaded
            .list_profiles()
            .unwrap()
            .iter()
            .any(|profile| profile.id == "agent.codex"));
    }

    #[test]
    fn malformed_legacy_state_is_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agents.json");
        let original = br#"{"version":1,"agents":{"bad":{"displayName":"Bad","command":"x","cwd":"relative"}}}"#;
        std::fs::write(&path, original).unwrap();
        assert!(FileAgentProfileRegistry::new(path.clone(), Arc::new(EmptySecrets)).is_err());
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[test]
    fn legacy_secret_reference_stays_an_indirection() {
        let document = LegacyAgentDocument {
            version: 1,
            agents: BTreeMap::from([(
                "agent.x".to_owned(),
                LegacyAgentDefinition {
                    id: Some("agent.x".to_owned()),
                    display_name: "X".to_owned(),
                    description: None,
                    command: "x".to_owned(),
                    args: vec![],
                    cwd: PathBuf::from("/tmp"),
                    environment: BTreeMap::from([(
                        "TOKEN".to_owned(),
                        LegacyEnvironmentSource::SecretReference {
                            reference: "keychain.token".to_owned(),
                        },
                    )]),
                    permission_policy: Some("ask".to_owned()),
                    enabled: Some(true),
                },
            )]),
        };
        let state = convert_legacy_document(document).unwrap();
        let spec = &state.registry.agents["agent.x"].spec;
        let LaneSpec::Acp { .. } = spec.lane else {
            panic!("legacy ACP enrollment keeps its lane")
        };
        let EnvPolicy::Sanitized { set, .. } = &spec.command.env else {
            panic!("converted environment remains sanitized")
        };
        assert_eq!(
            set["TOKEN"],
            EnvValue::Source(EnvSource::Secret {
                secret: "keychain.token".to_owned()
            })
        );
    }
}
