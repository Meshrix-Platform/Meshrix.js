/**
 * http-response.ts — Minimal HTTP response primitives for foundation layer.
 *
 * These are protocol-agnostic response formatting utilities that the contracts
 * and foundation layers may use without importing from packages/protocols.
 *
 * OTel Semantic Convention Fields (adoption baseline):
 *   http.status_code, http.route
 */

/**
 * Send a JSON response over a Node.js HTTP response object.
 *
 * @param {import("node:http").ServerResponse} response
 * @param {number} statusCode
 * @param {*} payload
 */
export function sendJson(response?: any, statusCode?: any, payload?: any) : any {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}
