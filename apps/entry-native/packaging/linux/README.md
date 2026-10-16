# Meshrix Entry portable Linux artifact

Version: `{{version}}`  
Component: `{{component}}`  
Architecture: `{{arch}}`  
Rust target: `{{rustTarget}}` (`{{libc}}`)  
Build source qualification: `{{buildSource}}`

Extract the archive into a directory you can write to, then launch the ELF
entrypoint from that directory:

```sh
./{{binary}} --version
```

For the GUI, run `./bin/meshrix-entry-gui` to open the desktop application. For the
CLI/TUI, pass a CLI command or run `./bin/meshrix-entry tui`. The archive does not
install system packages, modify user configuration or include enrolled-agent
state, credentials, journals or local build caches.

The CLI/TUI archive targets musl. Verify static linkage from the matching
artifact report rather than inferring it from the target name. The GUI archive
targets GNU and needs a host X11 or Wayland display stack plus compatible
graphics drivers. The display server, compositor and graphics drivers are
provided by the host.

The packager reads the actual ELF headers and records these facts:

- ELF machine: `{{elfMachine}}`
- ELF class: `{{elfClass}}`
- Program interpreter: `{{elfInterpreter}}`
- Direct `DT_NEEDED` libraries: `{{elfNeededLibraries}}`
- Source-confirmed `dlopen` candidates: `{{elfDlopenCandidates}}`
- Bundled shared libraries: `{{elfBundledLibraries}}`
- Host shared-library requirements: `{{elfHostLibraries}}`
- Highest required GLIBC symbol version: `{{elfHighestGlibcRequirement}}`
- Package-wide GLIBC symbol requirement: `{{elfPackageGlibcRequirement}}`
- Other versioned ABI requirements: `{{elfVersionedRequirements}}`
- ELF RUNPATH/RPATH: `{{elfRunpath}}`

{{hostDisplay}}

{{hostGpu}}

The source-confirmed `dlopen` list reflects this build's resolved Cargo
features; candidates may be optional for the selected display backend. The
packager bundles redistributable runtime libraries only when it can include
their complete shared-library and license closure. Each bundled library has an
`$ORIGIN` RUNPATH so the ELF loader can find adjacent bundle libraries without
setting a process-wide library path. The ELF facts describe this exact binary;
they do not promise universal Linux support.

`artifact.json` records the artifact target, sanitized build-source
qualification and ELF facts. `THIRD_PARTY_LICENSES.md` indexes Cargo and
bundled system-library license files under `licenses/`. The GUI archive also
carries the Inter font license for the fonts embedded in its binary.
