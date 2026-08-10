.PHONY: test verify image image-refresh

IMAGE ?= meshrix-format-convert:local

test:
	go test ./...

verify:
	gofmt -w cmd internal
	go test ./...
	go vet ./...

image:
	docker build --pull=false --tag $(IMAGE) .

image-refresh:
	docker build --pull --tag $(IMAGE) .
