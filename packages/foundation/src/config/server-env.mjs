export const DEFAULT_SERVER_PORT = 7228;

export function getDefaultServerUrl(options = {}) {
  const port = Number(options.port || process.env.LICO_SERVER_PORT || DEFAULT_SERVER_PORT);
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_SERVER_PORT;
  return `http://127.0.0.1:${safePort}`;
}
