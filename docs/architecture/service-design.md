# Service design

Design and development guidance for the services in this repository.

## Boundaries

- Services are optional upstream implementations. They integrate with Meshrix
  only through published service and extension contracts and never import Core
  implementation modules or depend on a sibling source checkout.
- Each service is an independent module with its own build, tests, image, and
  acceptance workflow.
- Services are stateless: uploads are processed in per-request workspaces that
  are deleted after the response finishes.

## format-convert design notes

- Go's HTTP server runs every request in its normal goroutine. There is no
  result cache and no custom worker pool.
- `MAX_CONCURRENCY` bounds only simultaneous LibreOffice processes. At most
  `QUEUE_CAPACITY` goroutines may wait for a slot, for no longer than
  `QUEUE_TIMEOUT`; additional requests receive a bounded
  `503 conversion_capacity_exhausted` response.
- PDF rendering uses LibreOffice Writer with an isolated profile per request.
- File names and document content are never written to logs.

## Development loop

```bash
cd file-parser/format-convert
gofmt -l .
go vet ./...
go test ./...
```

Run `make image` and `python3 scripts/acceptance.py` before shipping behavior
changes. Keep fixtures synthetic, and keep runtime data, credentials, private
endpoints, and local paths out of source, tests, and documentation.
