//! Generic local probing driven by maintained A4AA AgentCards.
//!
//! This module contains host filesystem logic only. It has no per-product
//! catalog: executable names, bundled paths and configuration markers come
//! from each card's `DetectSurface`, while lane and command behavior come
//! from `AgentCard::spec`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use a4aa::card::{AgentCard, FeatureSurface};
use a4aa::AgentSpec;

/// One A4AA card resolved against this machine. Availability remains separate
/// from enrollment in the AwP document.
#[derive(Clone)]
pub(crate) struct DetectedAgent {
    card: &'static AgentCard,
    pub spec: AgentSpec,
    binary: Option<PathBuf>,
    app: Option<PathBuf>,
    configured: bool,
    prior_use: bool,
}

impl DetectedAgent {
    pub(crate) fn id(&self) -> &str {
        self.card.id
    }

    pub(crate) fn label(&self) -> &str {
        self.card.label
    }

    pub(crate) fn features(&self) -> &'static FeatureSurface {
        &self.card.features
    }

    pub(crate) fn callable(&self) -> bool {
        self.binary.is_some()
    }

    pub(crate) fn evidence_label(&self) -> Option<String> {
        match (
            self.binary.is_some(),
            self.app.is_some(),
            self.configured || self.prior_use,
        ) {
            (true, true, _) => Some("cli+desktop".to_owned()),
            (true, false, _) => Some("cli".to_owned()),
            (false, true, _) => Some("desktop".to_owned()),
            (false, false, true) => Some("configured".to_owned()),
            (false, false, false) => None,
        }
    }
}

/// Resolve every available A4AA card. The card list itself is authoritative;
/// no hand-maintained product names or commands are kept here.
pub(crate) fn scan_local_agents() -> Vec<DetectedAgent> {
    let shared_bin_dirs = candidate_bin_dirs();
    a4aa_dialects::cards()
        .map(|(_, card)| detect_card(card, &shared_bin_dirs))
        .collect()
}

fn detect_card(card: &'static AgentCard, shared_bin_dirs: &[PathBuf]) -> DetectedAgent {
    let mut bin_dirs = shared_bin_dirs.to_vec();
    bin_dirs.extend(card.detect.binary_dirs.iter().filter_map(expand_os_path));
    dedupe_paths(&mut bin_dirs);

    let binary = card
        .detect
        .binaries
        .iter()
        .find_map(|name| resolve_binary(&bin_dirs, name));
    let app = card
        .detect
        .apps
        .iter()
        .filter_map(expand_os_path)
        .find(|path| path.exists());
    let configured = card
        .detect
        .config
        .iter()
        .filter_map(|template| expand_path_template(template))
        .any(|path| path.exists());
    let prior_use = card
        .detect
        .detection
        .iter()
        .filter_map(|template| expand_path_template(template))
        .any(|path| path.exists());

    let mut spec = card.spec();
    if let Some(path) = &binary {
        spec.command.program = path.to_string_lossy().into_owned();
    }
    DetectedAgent {
        card,
        spec,
        binary,
        app,
        configured,
        prior_use,
    }
}

fn candidate_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let home = home_dir();
    for relative in [
        ".local/bin",
        ".cargo/bin",
        ".bun/bin",
        ".deno/bin",
        ".volta/bin",
        ".asdf/shims",
        ".local/share/mise/shims",
        ".npm-global/bin",
        "go/bin",
        "Library/pnpm",
    ] {
        dirs.push(home.join(relative));
    }
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

    #[cfg(windows)]
    {
        for variable in ["APPDATA", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(variable) {
                dirs.push(PathBuf::from(root).join("Programs"));
            }
        }
    }

    let nvm_versions = home.join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(nvm_versions) {
        dirs.extend(entries.flatten().map(|entry| entry.path().join("bin")));
    }
    dedupe_paths(&mut dirs);
    dirs
}

fn dedupe_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
}

fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let raw = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let raw = std::env::var_os("HOME");
    raw.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

fn current_os_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(windows)]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        "unknown"
    }
}

fn expand_os_path(path: &a4aa::card::OsPath) -> Option<PathBuf> {
    let oses = path.oses;
    if !oses.is_empty() && !oses.contains(&current_os_name()) {
        return None;
    }
    expand_path_template(path.path)
}

fn expand_path_template(template: &str) -> Option<PathBuf> {
    let home = home_dir();
    let xdg_config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let xdg_data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let mut expanded = template.to_owned();
    for (marker, value) in [
        ("{home}", Some(home)),
        ("{xdg_config}", Some(xdg_config)),
        ("{xdg_data}", Some(xdg_data)),
        ("{appdata}", appdata),
    ] {
        if expanded.contains(marker) {
            let value = value?;
            expanded = expanded.replace(marker, &value.to_string_lossy());
        }
    }
    if expanded.contains('{') || expanded.contains('}') {
        return None;
    }
    Some(PathBuf::from(expanded))
}

fn resolve_binary(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let names = [
        format!("{name}.exe"),
        format!("{name}.cmd"),
        format!("{name}.bat"),
    ];
    #[cfg(not(windows))]
    let names = [name.to_owned()];

    for directory in dirs {
        for candidate in &names {
            let path = directory.join(candidate);
            if is_executable(&path) {
                return Some(path);
            }
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_catalog_is_owned_by_a4aa_and_includes_antigravity() {
        let cards: Vec<_> = a4aa_dialects::cards().map(|(_, card)| card).collect();
        assert!(cards.iter().any(|card| card.id == "antigravity"));
    }

    #[test]
    fn card_detection_records_are_templates_until_explicit_enrollment() {
        let cards = scan_local_agents();
        let antigravity = cards.iter().find(|agent| agent.id() == "antigravity");
        assert!(antigravity.is_some());
        assert_eq!(antigravity.unwrap().spec.id, "antigravity");
    }

    #[test]
    fn path_templates_expand_a4aa_owned_host_markers() {
        let home = home_dir();
        assert_eq!(
            expand_path_template("{home}/.local/bin/codex").unwrap(),
            home.join(".local/bin/codex")
        );
        assert!(expand_path_template("{unknown}/agent").is_none());
    }
}
