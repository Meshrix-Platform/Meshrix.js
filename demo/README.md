# Local demo workspaces

`demo/` is the unified local home for demo scenes, mockups, sample
configurations, and scratch design assets. Everything in this directory
except this README is git-ignored: demos stay on the machine that created
them and are never committed, published, or shipped.

- Put each demo in its own subdirectory (`demo/<name>/`) so it can be
  removed cleanly.
- Do not place product source, canonical design assets, or documentation
  here — shared art belongs to `assets/` (see
  [docs/design/README.md](../docs/design/README.md)) and committed
  walkthroughs belong to `docs/examples/`.
- Demos may consume repository builds and local services but must not
  contain credentials, private endpoints, personal data, or machine-local
  secrets.
