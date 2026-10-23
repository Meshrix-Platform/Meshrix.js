export const DEFAULT_SERVER_PORT = 7228;
export const DEFAULT_VITE_PORT = 5173;

function resolvePort(value: string | number | undefined, fallback: number): number {
  const port = Number(value || fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

export function resolveServerPort(options: { port?: string | number } = {}): number {
  return resolvePort(options.port || globalThis.process?.env?.MESHRIX_SERVER_PORT, DEFAULT_SERVER_PORT);
}

export function resolveVitePort(options: { port?: string | number } = {}): number {
  return resolvePort(options.port || globalThis.process?.env?.MESHRIX_VITE_PORT, DEFAULT_VITE_PORT);
}

export function getDefaultServerUrl(options: { port?: string | number } = {}): string {
  return `http://127.0.0.1:${resolveServerPort(options)}`;
}
