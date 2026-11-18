/**
 * Meshrix.js server HTTP listener lifecycle.
 *
 * Thin wrappers around the Node.js HTTP server listen / close lifecycle.
 * Used by bootstrap.ts for a clear separation between server setup and
 * the actual listen / stop phase.
 *
 * Consumed by:
 *   - bootstrap.ts
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
export function listen(server?: any, options: Record<string, any> = {}) : any {
  const host: any = options.host || "127.0.0.1";
  const port: any = Number.isFinite(options.port) ? options.port : 0;

  return new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);

    server.listen(port, host, () : any => {
      server.removeListener("error", reject);

      const addressInfo: any = server.address();
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
 * that is bootstrap.ts's responsibility.
 *
 * @param {import("node:http").Server} server
 * @returns {Promise<void>}
 */
export function stop(server?: any) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error?: any) : any => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
