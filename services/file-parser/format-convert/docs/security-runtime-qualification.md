# Synthetic runtime qualification — 2026-10-11

This records module engineering evidence, not independent final acceptance or
production deployment. Only generated documents, temporary credentials, local
OTLP receivers and test-owned paths were used. No user/runtime data was read.

## Maintained entry point

`python3 scripts/acceptance.py` builds the release and qualification stages and
executes the compiled Go tests plus actual HTTP contracts. Final output:

```json
{"ok":true,"checks":["go-tests-production-policy","go-vet","container-build","otlp-protocol-contracts","readiness","txt-to-docx","response-digest","no-store","docx-to-pdf","bounded-concurrency-smoke","prometheus-openmetrics","json-structured-logs","w3c-trace-correlation","log-privacy","otlp-http-traces","otlp-http-metrics","graceful-telemetry-flush"]}
```

Local synthetic image tags: `meshrix-format-convert:acceptance`,
`meshrix-format-convert:acceptance-qualification`,
`meshrix-js-format-convert:qualification`. Images were not published.

## Exact execution policy

Both stages ran as image UID/GID 10001 with read-only root, all container
capabilities dropped, no-new-privileges, the maintained `security/seccomp-office.json`,
one CPU, 2 GiB memory and memory-swap limits, 256 processes, and
`/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777`.
GOMAXPROCS, MAX_CONCURRENCY and QUEUE_CAPACITY are each one. These are the root
Compose service settings. No privileged, SYS_ADMIN or unconfined execution was
used. Dependencies came from the public official Go and Debian images/packages;
no host software or daemon settings were changed.

## Actual implementation evidence

| Scenario | Result | Scope |
| --- | --- | --- |
| Installed LibreOffice readiness | Pass | Actual bubblewrap sandbox, direct Debian headless runtime |
| Generated Chinese DOCX to PDF | Pass | `TestInstalledLibreOfficeSandboxConvertsSyntheticDOCX` |
| Generated legacy DOC to PDF | Pass | DOC generated inside the same sandbox; regular PDF validated |
| HTTP Chinese TXT/DOCX to PDF | Pass | Actual HTTP handler and installed Office |
| Archive rejection and legitimate documents | Pass | Compiled service tests, including actual expanded bytes/CRC and zero converter invocations for unsafe input |
| Other synthetic workspace read/write | Pass | Static Go helper executed inside the actual sandbox |
| Network access to test-owned local listener | Denied as required | Static Go helper, no public network probing |
| Viable admitted process until user cancellation | Pass | Actual helper has no duration deadline and remains running until explicit cancellation; this is semantic coverage, not an elapsed 120-second endurance test |
| Concurrent HTTP conversions | Pass | One active plus one queued request under the actual cgroup policy |
| Logs, metrics and OTLP | Pass | Synthetic correlations and privacy contract; graceful flush |

Shell executables placed in `/tmp` are deliberately not runnable under the
production noexec mount. Shell-fixture-only tests report this prerequisite as
skipped there; installed Office and the static runtime probes provide actual
sandbox execution coverage. Host macOS tests remain separate: the installed
wrapper does not resolve to a qualified direct app executable, so actual native
Office conversion is not run. Windows native Office isolation is not qualified.
Neither native platform is represented as having passed the Linux qualification.

## Diagnosed production defects and correction

A new procfs mount was rejected under the container policy. The sandbox now
keeps an empty read-only `/proc`, while retaining separate PID/network/mount
namespaces. The splash launcher needs procfs; the direct headless executable
uses its exact trusted library directory. LibreOffice required a writable IPC
location: `/var/tmp` now aliases only the current request workspace, rather than
making the root or a shared temporary directory writable. Its documented normal
startup status 81 requests the same arguments/profile to restart, as implemented
by [LibreOffice startup source](https://github.com/LibreOffice/core/blob/libreoffice-7.4.7.2/desktop/unx/source/start.c)
and [exit codes](https://github.com/LibreOffice/core/blob/libreoffice-7.4.7.2/include/desktop/exithelper.h).
Crash status 79 is not replayed. The safe Office profile is written to the actual
`user/registrymodifications.xcu` location before launch.

The acceptance script had required five trace IDs although it sends only four
conversion requests. The unused fifth expectation was removed; no logging
requirement was weakened. The successful run above followed that correction.
