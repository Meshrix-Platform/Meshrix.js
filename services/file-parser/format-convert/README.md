# File Format Conversion Service

`file-parser/format-convert` is a stateless HTTP service that converts UTF-8
`.txt` documents to DOCX or PDF and converts `.doc` and `.docx` documents to PDF.
PDF rendering uses LibreOffice Writer. The service does not persist uploads or
depend on Meshrix Core internals.

This service is distributed under Apache-2.0 as part of the Meshrix.js
repository-local service tree. See
the local [`LICENSE`](LICENSE).

## Current contract status

The canonical and only conversion endpoint is the multipart `/v1/convert`
contract documented below. Document bytes are never transported through a JSON
or Base64 compatibility route.

## API

### Convert a document

```text
POST /v1/convert
Authorization: Bearer <token loaded from FORMAT_CONVERT_AUTH_TOKEN_FILE>
Content-Type: multipart/form-data
file: one .txt, .doc, or .docx document
targetFormat: optional output format
```

`FORMAT_CONVERT_AUTH_TOKEN_FILE` is required at startup and must be an absolute
path to a regular file containing a 32–512 byte bearer token. The service reads
the file once during startup and keeps only the token in memory.
The service rejects missing, malformed, duplicate, or incorrect authorization
before reading the upload, creating a workspace, or consuming conversion
capacity. The configured token is never included in errors or logs. Keep the
service on a private network and use HTTPS whenever the request crosses an
untrusted network; bearer authentication does not encrypt a plaintext HTTP
connection.

A successful request returns the converted file directly with
`Content-Disposition`, `Content-Length`, and a SHA-256 `Digest` header. Errors
are bounded JSON objects with a stable error code.

| Input | `targetFormat` | Result |
| --- | --- | --- |
| `.txt` | omitted or `pdf` | DOCX is generated temporarily and rendered to PDF |
| `.txt` | `docx` | DOCX |
| `.doc` or `.docx` | omitted or `pdf` | PDF |

TXT input must be valid UTF-8. A UTF-8 BOM is accepted. Blank lines delimit
paragraphs and wrapped lines inside a paragraph are joined with spaces. The
generated DOCX uses A4 pages, fixed margins, Liberation Serif, justified body
text, first-line indentation, and consistent paragraph spacing.

Example:

```bash
curl --fail-with-body \
  --header 'Authorization: Bearer <token-read-from-the-host-secret-store>' \
  --form 'file=@<input-file>.docx' \
  --output '<output-file>.pdf' \
  http://127.0.0.1:8080/v1/convert
```

TXT to DOCX:

```bash
curl --fail-with-body \
  --header 'Authorization: Bearer <token-read-from-the-host-secret-store>' \
  --form 'file=@<input-file>.txt' \
  --form 'targetFormat=docx' \
  --output '<output-file>.docx' \
  http://127.0.0.1:8080/v1/convert
```

TXT to PDF:

```bash
curl --fail-with-body \
  --header 'Authorization: Bearer <token-read-from-the-host-secret-store>' \
  --form 'file=@<input-file>.txt' \
  --output '<output-file>.pdf' \
  http://127.0.0.1:8080/v1/convert
```

### Convert through Meshrix upstream gateway

The gateway operation uses the native `/v1/convert` multipart endpoint. MCP and
other JSON-only callers pass an owner-bound artifact reference in the `file`
argument; Core streams it as the multipart `file` part. The optional
`targetFormat` argument is mapped to the multipart field of the same name. If
it is omitted, this service selects PDF. The result is stored as an
owner-bound artifact and returned as an MCP `resource_link`; document bytes are
not embedded in JSON or Base64 encoded. Core sends one `Authorization: Bearer`
header resolved from its host-held credential reference. The same random
service token must be provisioned into the Core secret store and the
read-only file referenced by `FORMAT_CONVERT_AUTH_TOKEN_FILE`.

This paragraph describes the canonical gateway contract.

Import
[`docs/examples/file-parser-format-convert.upstream.json`](../../../docs/examples/file-parser-format-convert.upstream.json)
directly when Core and this container share a network where the service is
reachable as `format-convert:8080`. Otherwise replace `baseUrl` with a
Core-reachable HTTP(S) URL that includes an explicit port. The complete document
is:

```json
{
  "kind": "meshrix.upstream-service",
  "schemaVersion": "v0.0.1:upstream-service:portable-import-2",
  "serviceKey": "file-parser/format-convert",
  "descriptor": {
    "serviceProtocol": "http",
    "label": "File Parser / Format Convert",
    "description": "Convert an owner-bound uploaded document without Base64 encoding.",
    "baseUrl": "http://format-convert:8080",
    "healthPath": "/readyz",
    "allowLocalNetwork": true,
    "tags": ["file-parser", "format-convert"],
    "references": [
      {
        "type": "credential",
        "reference": "secret://meshrix/file-parser/format-convert/request-auth",
        "revision": 1,
        "use": "request-auth",
        "host": "format-convert",
        "protocol": "http",
        "scopes": []
      }
    ],
    "trafficPolicy": {
      "perMinute": 120,
      "burst": 20,
      "maxConcurrent": 4
    },
    "operations": [
      {
        "operationKey": "convert",
        "label": "Convert document",
        "protocol": "http",
        "method": "POST",
        "path": "/v1/convert",
        "risk": "safe_write",
        "requiredScopes": ["gateway:write"],
        "payloadTransport": {
          "request": {
            "mode": "artifact_multipart",
            "maxBytes": 53477376,
            "mediaTypes": ["multipart/form-data"],
            "multipart": {
              "artifactParts": [
                { "argument": "file", "partName": "file", "required": true }
              ],
              "scalarFields": [
                { "argument": "targetFormat", "partName": "targetFormat", "required": false }
              ],
              "maxParts": 2
            }
          },
          "response": {
            "mode": "artifact",
            "maxBytes": 104857600,
            "mediaTypes": [
              "application/pdf",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ],
            "allowRanges": true
          }
        }
      }
    ]
  }
}
```

### Health

- `GET /healthz` reports process health.
- `GET /readyz` verifies that the configured LibreOffice executable is present.
- These two minimal probes remain unauthenticated. `GET /metrics` requires the
  same bearer token as conversion.

### Observability

- `GET /metrics` exposes the standard Prometheus text format.
- Incoming W3C `traceparent` and `tracestate` headers are extracted by the
  OpenTelemetry HTTP instrumentation.
- OTLP trace and metric export uses the standard `OTEL_EXPORTER_OTLP_*`
  environment variables and supports `grpc` and `http/protobuf`.
- `OTEL_SERVICE_NAME` and standard OpenTelemetry resource attributes are
  honored. `OTEL_SDK_DISABLED=true` switches to no-op providers.

The service publishes standard HTTP server metrics and low-cardinality
conversion metrics. Conversion spans and histograms split work into
`multipart.receive`, `input.validate`, `txt.docx.build`, `capacity.acquire`,
`libreoffice.exec`, `output.validate_hash`, and `response.stream`. File names,
paths, document contents, request identifiers, and trace identifiers are not
metric labels.

Application logs are newline-delimited JSON on standard output. Conversion
completion records include `trace_id` and `span_id` when a sampled or propagated
trace context exists, so a private log backend can correlate the record without
introducing a non-standard logging protocol. Document names, paths, and content
are never logged.

For OTLP/HTTP, a common endpoint is a base URL and the official exporter appends
the signal path:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Signal-specific OTLP/HTTP endpoints are complete URLs, as required by the OTLP
exporter specification:

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://collector:4318/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://collector:4318/v1/metrics
```

The service does not depend on Prometheus, Grafana, Tempo, or an OpenTelemetry
Collector. Those systems are optional consumers of the standard interfaces.


## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PORT` | `8080` | HTTP listen port |
| `MAX_UPLOAD_BYTES` | `52428800` | Maximum input size |
| `MAX_OUTPUT_BYTES` | `104857600` | Maximum DOCX or PDF output size |
| `MAX_CONCURRENCY` | Go runtime parallelism | Concurrent conversions |
| `QUEUE_CAPACITY` | `MAX_CONCURRENCY` | Requests allowed to wait for conversion capacity |
| `QUEUE_TIMEOUT` | `5s` | Maximum wait for conversion capacity |
| `TEMP_ROOT` | operating-system temp directory | Per-request workspace parent |
| `SOFFICE_BINARY` | `soffice` | LibreOffice CLI executable |
| `FORMAT_CONVERT_AUTH_TOKEN_FILE` | required | Absolute path to a regular file with the bearer token for `/v1/convert` and `/metrics` (32–512 bytes) |

Go's HTTP server runs every request in its normal goroutine. There is no result
cache and no custom worker pool. `MAX_CONCURRENCY` bounds admitted conversion
requests from before upload reads through response streaming. At most
`QUEUE_CAPACITY` requests may wait for capacity, for no longer than
`QUEUE_TIMEOUT`; requests rejected at admission do not read the body or create
a workspace. Additional requests receive a bounded
`503 conversion_capacity_exhausted` response.

Admitted conversions have no internal duration deadline. Client cancellation and
external process failure terminate the operation; admission, concurrency, upload,
expanded archive, output and sandbox resource limits bound consumption. The HTTP
server limits header reads and idle connections, without an active body-read or
response-write deadline.

DOCX validation reads actual member streams and verifies their ZIP checksums under
a shared expanded-byte/member/nesting budget. Traversal, duplicate names, symbolic
links, encrypted members, malformed XML, entity directives and externally loaded
package content are rejected before Office starts. Ordinary external hyperlinks
remain available. Embedded ZIP packages share the same expansion budget. Macros
and automatic linked-content updates are disabled in each Office profile.

Office runs inside an operating-system sandbox: Linux uses bubblewrap mount,
network and process namespaces, with read-only runtime assets and sandbox root, a private writable
request directory, and per-process prlimit address-space/file-size ceilings.
The sandbox uses an empty read-only `/proc` and a `/var/tmp` alias to its own
request directory, so no parent process view or shared writable temporary
directory is exposed. Debian Office runs its direct headless binary with an
exact runtime library path. Its normal startup status 81 preserves the same
profile and restarts inside the same boundaries; crashes are not replayed.
The maintained Compose service adds cgroup ceilings shared by the server and all
converter descendants: one CPU, 2 GiB RAM with no swap allowance, 256 processes,
and a 512 MiB writable request scratch mount; concurrency is one. The per-process
nproc limit is supplementary and is not relied on as an aggregate bound. macOS uses
sandbox-exec with network access denied and file content limited to runtime assets
and the request directory. Converter children are terminated as a process group on
cancellation and after the operation finishes. A native macOS configuration must point `SOFFICE_BINARY` directly at the
LibreOffice app executable under its bundle `Contents/MacOS` directory; generic
launch wrappers that create files outside the request directory are not qualified.
macOS does not supply the Linux
namespace/prlimit resource ceilings; its native adapter requires separate runtime
and resource qualification. Windows native Office isolation is not qualified.
The maintained production artifact is the Linux container. Isolation is checked by converter readiness and never
falls back to unrestricted execution. Sandbox availability must be qualified on
the selected deployment; Linux requires unprivileged user namespaces enabled by
the host. `security/seccomp-office.json` retains Moby's default syscall policy and
adds namespace creation and mount operations required by bubblewrap. No host
capabilities, privileged mode or unconfined policy are granted. Namespace-scoped
mount privileges arise only inside the child user namespace and bubblewrap drops
capabilities before starting Office. A host LSM that prohibits this user namespace
still causes readiness failure; weakening the host policy is not automatic.
An image build or a static Compose check does not prove those permissions.

## Build and run

```bash
make image
```

Mount a protected bearer-token file read-only before running the container.
The image runs as UID/GID `10001:10001`; the file must be readable by that
identity. Keep the host file inside a directory inaccessible to other users,
since the container only needs read permission on the mounted file. A host
root-owned `0600` file is not readable by the service user unless ownership or
mode is adjusted.
The direct example publishes only on loopback and passes the file path, not the
secret value, through the container environment:

```bash
: "${FORMAT_CONVERT_AUTH_TOKEN_FILE:?set the protected host token-file path}"
docker run --rm --read-only \
  --cap-drop ALL --security-opt no-new-privileges=true \
  --security-opt seccomp=security/seccomp-office.json \
  --cpus 1 --memory 2g --memory-swap 2g --pids-limit 256 \
  --tmpfs "${CONTAINER_SCRATCH_DIR:-/tmp}:rw,noexec,nosuid,nodev,size=512m,mode=1777" \
  --env GOMAXPROCS=1 --env MAX_CONCURRENCY=1 \
  --env FORMAT_CONVERT_AUTH_TOKEN_FILE=/run/secrets/format-convert-auth-token \
  --mount "type=bind,src=${FORMAT_CONVERT_AUTH_TOKEN_FILE},dst=/run/secrets/format-convert-auth-token,readonly" \
  --publish 127.0.0.1:8080:8080 \
  meshrix-format-convert:local
```

`CONTAINER_SCRATCH_DIR` is the in-container scratch directory mounted as an
ephemeral `tmpfs`; it defaults to the container temporary directory.

`make image` reuses the local Docker and BuildKit caches. Use `make
image-refresh` only when intentionally refreshing the pinned base-image line.

The image runs as an unprivileged user. Each request receives an isolated
temporary directory and LibreOffice profile; the directory is deleted after the
response finishes. File names and document content are not written to logs.

Production deployment must additionally deny outbound network access from the service and
enforce CPU, memory, process, and ephemeral-storage limits. The image installs
a fixed font set (DejaVu Core, Liberation 2, and Noto CJK for Chinese,
Japanese, and Korean text) so that PDF pagination and line wrapping stay
deterministic. Install any additional organization-required fonts into a
derived image and keep that font set fixed; font substitutions can change
pagination and line wrapping.

## Test

```bash
go test ./...
```

The image build compiles the Go test binary and runs static vetting. Sandbox
checks run in the `qualification` image stage under the same production seccomp,
capability, filesystem and cgroup settings; BuildKit's compile stage is not a
substitute for those runtime permissions. The final release image omits the test
binary. `python3 scripts/acceptance.py` builds both stages and runs the compiled
tests and HTTP conversions under those production settings. Container builds and
deployment verification use synthetic input only.

### Container sandbox policy provenance

The service policy is derived from the [Moby default seccomp profile](https://github.com/moby/profiles/blob/main/seccomp/default.json), retrieved 2026-10-11,
under the accompanying `security/LICENSE.moby`. The added allow rules cover
`clone`, `unshare`, `mount`, `umount2`, `pivot_root`, `sethostname`, and
`setdomainname` for [bubblewrap namespace setup](https://github.com/containers/bubblewrap).
The namespace clone rules admit only the complete namespace combination used
by `--unshare-all` (with optional cgroup namespace), while `unshare` admits only
the user/PID operations used by bubblewrap. Kernel capability checks continue to apply: the unprivileged container cannot
mount or modify the host namespaces. Every conversion creates its own user,
mount, PID, network, IPC and UTS namespaces; the container cgroup budgets remain
inherited across those namespaces. Production qualification must execute a real
legal document conversion and forbidden filesystem/network synthetic probes
under this exact policy. Missing prerequisites are reported as not run rather
than accepted isolation.
