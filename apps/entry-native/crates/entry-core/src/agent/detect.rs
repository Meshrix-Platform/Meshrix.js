//! Generic local probing driven by maintained A4AA AgentCards.
//!
//! This module contains host filesystem logic only. It has no per-product
//! catalog: executable names, bundled paths and configuration markers come
//! from each card's `DetectSurface`, while lane and command behavior come
//! from `AgentCard::specs`, preserving each executable's declared lane.

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
    pub(crate) alternates: Vec<AgentSpec>,
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

    // A detection name is not a protocol declaration. In particular an ACP
    // primary and its CLI alternate may use different executables. Resolve
    // the complete specs in the card's preference order, pick the first
    // executable that exists as the enrolled lane, and keep every later
    // resolvable lane as a runtime alternate.
    let mut specs = card.specs();
    let resolved: Vec<Option<PathBuf>> = specs
        .iter_mut()
        .map(|spec| {
            resolve_binary(&bin_dirs, &spec.command.program).inspect(|path| {
                spec.command.program = path.to_string_lossy().into_owned();
            })
        })
        .collect();
    let selected = resolved.iter().position(Option::is_some);
    let (spec, alternates, binary) = match selected {
        Some(index) => {
            let alternates = specs[index + 1..]
                .iter()
                .zip(&resolved[index + 1..])
                .filter(|(_, path)| path.is_some())
                .map(|(spec, _)| spec.clone())
                .collect();
            (specs[index].clone(), alternates, resolved[index].clone())
        }
        None => (card.spec(), Vec::new(), None),
    };
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

    DetectedAgent {
        card,
        spec,
        alternates,
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

    #[cfg(unix)]
    fn antigravity_with_binaries(names: &[&str]) -> (tempfile::TempDir, DetectedAgent) {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().expect("isolated detection directory");
        for name in names {
            let binary = directory.path().join(name);
            std::fs::write(&binary, "#!/bin/sh\nexit 99\n")
                .expect("write detection-only executable");
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755))
                .expect("make detection-only fixture executable");
        }
        let card = a4aa_dialects::card("antigravity").expect("maintained card");
        let detected = detect_card(card, &[directory.path().to_path_buf()]);
        (directory, detected)
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_primary_only_uses_acp_executable_and_lane() {
        let (directory, detected) = antigravity_with_binaries(&["agy_acp_server.par"]);
        assert!(detected.callable());
        assert_eq!(
            PathBuf::from(&detected.spec.command.program),
            directory.path().join("agy_acp_server.par")
        );
        assert!(matches!(&detected.spec.lane, a4aa::LaneSpec::Acp { .. }));
        assert!(
            a4aa::Adapter::new(detected.spec)
                .capabilities()
                .permission_prompts
        );
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_alternate_only_keeps_cli_protocol_and_arguments() {
        let (directory, detected) = antigravity_with_binaries(&["agy"]);
        assert!(detected.callable());
        assert_eq!(
            PathBuf::from(&detected.spec.command.program),
            directory.path().join("agy")
        );
        let a4aa::LaneSpec::Cli(lane) = &detected.spec.lane else {
            panic!("the CLI executable must never receive an ACP handshake");
        };
        assert_eq!(&lane.args[..2], &["--print", "{prompt}"]);
        assert!(lane.json_lines);
        assert!(matches!(lane.stream, a4aa::StreamMode::Stdio));
        assert_eq!(
            detected.spec.lane,
            a4aa_dialects::card("antigravity").unwrap().specs()[1].lane
        );
        assert!(
            !a4aa::Adapter::new(detected.spec)
                .capabilities()
                .permission_prompts
        );
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_both_executables_preserve_primary_preference() {
        let (directory, detected) = antigravity_with_binaries(&["agy", "agy_acp_server.par"]);
        assert!(detected.callable());
        assert_eq!(
            PathBuf::from(&detected.spec.command.program),
            directory.path().join("agy_acp_server.par")
        );
        assert!(matches!(&detected.spec.lane, a4aa::LaneSpec::Acp { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_without_executable_stays_an_uncallable_template() {
        let (_directory, detected) = antigravity_with_binaries(&[]);
        assert!(!detected.callable());
        assert_eq!(detected.spec.command.program, "agy_acp_server.par");
        assert!(matches!(&detected.spec.lane, a4aa::LaneSpec::Acp { .. }));
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
