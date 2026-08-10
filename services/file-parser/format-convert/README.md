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
Content-Type: multipart/form-data
file: one .txt, .doc, or .docx document
targetFormat: optional output format
```

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
  --form 'file=@<input-file>.docx' \
  --output '<output-file>.pdf' \
  http://127.0.0.1:8080/v1/convert
```

TXT to DOCX:

```bash
curl --fail-with-body \
  --form 'file=@<input-file>.txt' \
  --form 'targetFormat=docx' \
  --output '<output-file>.docx' \
  http://127.0.0.1:8080/v1/convert
```

TXT to PDF:

```bash
curl --fail-with-body \
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
not embedded in JSON or Base64 encoded.

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
        "timeoutMs": 30000,
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
| `CONVERSION_TIMEOUT` | `2m` | Per-conversion deadline |
| `MAX_CONCURRENCY` | Go runtime parallelism | Concurrent conversions |
| `QUEUE_CAPACITY` | `MAX_CONCURRENCY` | Requests allowed to wait for conversion capacity |
| `QUEUE_TIMEOUT` | `5s` | Maximum wait for conversion capacity |
| `TEMP_ROOT` | operating-system temp directory | Per-request workspace parent |
| `SOFFICE_BINARY` | `soffice` | LibreOffice CLI executable |

Go's HTTP server runs every request in its normal goroutine. There is no result
cache and no custom worker pool. `MAX_CONCURRENCY` bounds only simultaneous
LibreOffice processes; uploads, TXT-to-DOCX generation, hashing, and response
streaming do not hold a LibreOffice slot. At most `QUEUE_CAPACITY` goroutines
may wait for a slot, for no longer than `QUEUE_TIMEOUT`. Additional requests
receive a bounded `503 conversion_capacity_exhausted` response.

## Build and run

```bash
make image
docker run --rm --read-only \
  --cpus 1 --memory 2g --memory-swap 2g --pids-limit 512 \
  --tmpfs "${CONTAINER_SCRATCH_DIR:-/tmp}:rw,noexec,nosuid,size=512m,mode=1777" \
  --env GOMAXPROCS=1 --env MAX_CONCURRENCY=1 \
  --publish 8080:8080 \
  meshrix-format-convert:local
```

`CONTAINER_SCRATCH_DIR` is the in-container scratch directory mounted as an
ephemeral `tmpfs`; it defaults to the container temporary directory.

`make image` reuses the local Docker and BuildKit caches. Use `make
image-refresh` only when intentionally refreshing the pinned base-image line.

The image runs as an unprivileged user. Each request receives an isolated
temporary directory and LibreOffice profile; the directory is deleted after the
response finishes. File names and document content are not written to logs.

Production deployment must deny outbound network access from the service and
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

Container builds and deployment verification must run in a clean container
environment.
