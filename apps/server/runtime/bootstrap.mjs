/**
 * LicoMesh server bootstrap.
 *
 * Parses configuration from environment variables and explicit options,
 * then creates and returns the HTTP server handle.
 *
 * Consumed by:
 *   - bin/lico.mjs (CLI entry point)
 *   - external launchers / test harnesses
 */

import { startHttpServer } from "./http-server.mjs";
import { ServerConfig } from "#lico/server-config";

/**
 * Parse a positive integer from a string value with a fallback.
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function parsePort(value, fallback = 0) {
  const parsed = parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

/**
 * Resolve runtime options from environment variables.
 * @param {object} [overrides={}]
 * @returns {object}
 */
function resolveRuntimeOptions(overrides = {}) {
  return {
    profile: process.env.LICO_PROFILE || "default",
    cleanRuntimeTempOnStart: process.env.LICO_CLEAN_TEMP !== "false",
    ...overrides
  };
}

/**
 * Bootstrap the LicoMesh HTTP server.
 *
 * @param {object} [options]
 * @param {string}  [options.userDataPath]   — data directory (default: ServerConfig.getDataDir())
 * @param {string}  [options.distPath]       — path to compiled frontend assets
 * @param {string}  [options.host]           — listen host (default: 127.0.0.1)
 * @param {number}  [options.port]           — listen port (default: 0 → OS-assigned)
 * @param {string}  [options.advertisedHost] — public-facing hostname
 * @param {object}  [options.runtimeOptions] — feature flags / runtime knobs
 * @param {object}  [options.discoveryOptions] — discovery layer overrides
 * @param {object}  [options.operationLockManager] — explicitly injected lock backend
 * @param {string}  [options.operationConcurrencyScope] — stable deployment lock scope
 * @returns {Promise<{server, host, port, url, discovery, close}>}
 */
export async function bootstrapServer(options = {}) {
  const host = options.host || process.env.LICO_HOST || "127.0.0.1";
  const port = parsePort(
    String(options.port ?? process.env.LICO_PORT ?? ""),
    0
  );
  const advertisedHost = options.advertisedHost || process.env.LICO_ADVERTISED_HOST || "";
  const userDataPath = options.userDataPath || process.env.LICO_SERVER_DATA_DIR || ServerConfig.getDataDir();
  const distPath = options.distPath || process.env.LICO_DIST_PATH || "";
  const runtimeOptions = resolveRuntimeOptions(options.runtimeOptions);
  const discoveryOptions = options.discoveryOptions || {};

  return startHttpServer({
    userDataPath,
    distPath,
    runtimeOptions,
    operationLockManager: options.operationLockManager ?? null,
    operationConcurrencyScope: options.operationConcurrencyScope ?? "",
    host,
    port,
    advertisedHost,
    discoveryOptions
  });
}
