export const DEFAULT_SERVER_PORT: any = 7228;

export function getDefaultServerUrl(options: Record<string, any> = {}) : any {
  const port: any = Number(options.port || process.env.MESHRIX_SERVER_PORT || DEFAULT_SERVER_PORT);
  const safePort: any = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_SERVER_PORT;
  return `http://127.0.0.1:${safePort}`;
}
