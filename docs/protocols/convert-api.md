# Conversion API

Canonical HTTP contract of the repository-local `file-parser/format-convert`
service. The implementation exposes no JSON/Base64 document transport route.

## Convert a document

```text
POST /v1/convert
Content-Type: multipart/form-data
file: one .txt, .doc, or .docx document
targetFormat: optional output format
```

A successful request returns the converted file directly with
`Content-Disposition`, `Content-Length`, a SHA-256 `Digest` header, and
`Cache-Control: no-store`. Errors are bounded JSON objects with a stable
error code.

Capacity is bounded: when no LibreOffice slot becomes available within
`QUEUE_TIMEOUT`, the service responds `503 conversion_capacity_exhausted`.

## Readiness

```text
GET /readyz
```

Reports whether the service is ready to accept conversions.

## Upstream gateway mapping

The Meshrix upstream gateway operation uses the native `/v1/convert`
multipart endpoint. The `file` argument carries an owner-bound artifact
reference that Core streams as the multipart `file` part; the optional
`targetFormat` argument maps to the multipart field of the same name. The
importable descriptor is
[examples/file-parser-format-convert.upstream.json](../examples/file-parser-format-convert.upstream.json).
