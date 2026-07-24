# AGENTS.md

## Cursor Cloud specific instructions

LicoMesh is a single Node.js product (an ESM `.mjs` "agent gateway" server plus a
Vue 3 operator Console). It is a self-contained npm-workspaces monorepo: the
default runtime stores all state locally (SQLite via `better-sqlite3` + local
files under the server data directory), so no external database, broker, or
network service is required to run or test the baseline product. Standard
commands live in `README.md`, `CONTRIBUTING.md`, `docs/RUNBOOK.md`, and
`package.json` `scripts` — prefer those. Only the non-obvious caveats are noted
below.

### Services and how to run them
- **API server (required):** `npm run dev` (dev profile) serves the API on
  `http://127.0.0.1:7228` in `api-only` mode (it does NOT serve the Console UI).
  Health check is `GET /api/healthz` (returns `{"ok":true,...}`); there is no
  `/health` or `/api/health` route — those return `404` with a JSON body.
- **Console UI (optional, for GUI work):** `npm run server:dev:web` runs Vite on
  `http://127.0.0.1:5173` and proxies `/api` → `:7228`, so the API server
  (`npm run dev`) must be running too. Alternatively the built bundle can be
  served by the server with `LICO_SERVER_WITH_UI=1` / `--with-ui`.

### Console login (non-obvious)
- Console auth is stored in the server data directory. A default `owner` user
  already exists but has no known password. Set one with
  `node tools/server-scripts/console-auth.mjs set-password --username owner --generate-password`
  (or `npm run server:auth:rotate`), then log in at the Console with `owner` +
  the printed password. Login posts to `/api/auth/login`; the login route
  bootstraps its own CSRF token so no pre-fetch is needed.
- `LICO_SERVER_DATA_DIR` controls where this state lives; the CLI and the server
  must point at the same data dir (both use the default when unset).

### Lint / test / build (non-obvious)
- "Lint" is the TypeScript gate: `npm run typecheck` (`vue-tsc`). There is no
  separate ESLint step.
- `npm test` runs the `core-public` profile via `tests/run.mjs`. Known
  pre-existing failure unrelated to environment setup: the `registry.consistency`
  suite fails because `tools/registry/fact-source-authority.registry.json`
  references `docs/plans/end-to-end-release/.../Checkpoints.json`, a path that is
  not present in the public `release` tree. The other suites
  (resource-discipline, public-boundary, secret-hygiene, local-info-hygiene)
  pass. Do not treat that registry failure as a broken dev environment.

### Node version caveat
- `undici@8.8.0` declares `engines.node >= 22.19.0`, but the repo engine range is
  `^22.0.0 || ^24.0.0` and the environment runs Node 22.14. This surfaces only as
  an `npm warn EBADENGINE` during install and does not block install, build,
  tests, or running the server.
