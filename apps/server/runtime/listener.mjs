/**
 * LicoMesh server HTTP listener lifecycle.
 *
 * Thin wrappers around the Node.js HTTP server listen / close lifecycle.
 * Used by bootstrap.mjs for a clear separation between server setup and
 * the actual listen / stop phase.
 *
 * Consumed by:
 *   - bootstrap.mjs
 *   - test / integration harnesses
 */

import http from "node:http";

/**
 * Start accepting connections on the given server.
 *
 * @param {import("node:http").Server} server
 * @param {object} [options]
 * @param {string} [options.host="127.0.0.1"]
 * @param {number} [options.port=0]
 * @returns {Promise<{host: string, port: number, address: import("node:net").AddressInfo}>}
 */
export function listen(server, options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number.isFinite(options.port) ? options.port : 0;

  return new Promise((resolve, reject) => {
    server.once("error", reject);

    server.listen(port, host, () => {
      server.removeListener("error", reject);

      const addressInfo = server.address();
      if (!addressInfo || typeof addressInfo === "string") {
        reject(new Error("Cannot determine server listen address."));
        return;
      }

      resolve({
        host: addressInfo.address,
        port: addressInfo.port,
        address: addressInfo
      });
    });
  });
}

/**
 * Gracefully stop the HTTP server.
 *
 * Closes the server (stops accepting new connections) and waits for the
 * `close` callback.  Does NOT shut down databases or other resources —
 * that is bootstrap.mjs's responsibility.
 *
 * @param {import("node:http").Server} server
 * @returns {Promise<void>}
 */
export function stop(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
