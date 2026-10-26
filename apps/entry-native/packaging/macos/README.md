# Meshrix Entry portable macOS artifact

Version: `{{version}}`  
Component: `{{component}}`  
Architecture: `{{arch}}`  
Rust target: `{{rustTarget}}` (`{{libc}}`)  
Build source qualification: `{{buildSource}}`

Extract the archive into a directory you can write to, then launch the Mach-O
entrypoint from that directory:

```sh
./{{binary}} --version
```

For the GUI, run `./bin/meshrix-entry-gui` to open the desktop application. For the
CLI/TUI, pass a CLI command or run `./bin/meshrix-entry tui`. The archive does not
install system packages, modify user configuration or include enrolled-agent
state, credentials, journals or local build caches.

Each artifact is a thin single-architecture Mach-O executable linked only
against system-provided dylibs and frameworks. No Homebrew or third-party
runtime library is required or bundled. The binary is unsigned: verify the
archive's SHA-256 against `SHA256SUMS.txt` published with the release, then
approve the entrypoint once in System Settings → Privacy & Security when
macOS Gatekeeper blocks a file downloaded from a browser.

The packager reads the actual Mach-O headers and records these facts:

- Mach-O architecture: `{{machoArch}}`
- Minimum macOS version: `{{machoMinimumMacOS}}`
- Direct dynamic library references: `{{machoLinkedLibraries}}`

`artifact.json` records the artifact target, sanitized build-source
qualification and Mach-O facts. `THIRD_PARTY_LICENSES.md` indexes Cargo
dependency license files under `licenses/`. The GUI archive also carries the
Inter font license for the fonts embedded in its binary.
