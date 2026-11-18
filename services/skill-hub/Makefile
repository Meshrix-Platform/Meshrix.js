.PHONY: test image

IMAGE ?= meshrix-skill-hub:local

test:
	npm test

image:
	docker build --pull=false --tag $(IMAGE) .
