import { DEFAULT_TOKEN_ENV } from "./constants.ts";
import { option } from "./basic-utils.ts";

export function redactSensitiveText(value?: any, secrets: any = []) : any {
  let text: any = String(value || "");
  const uniqueSecrets: any = new Set<any>(
    secrets.map((item?: any) : any => String(item || "")).filter((item?: any) : any => item.length > 0)
  );
  for (const secret of uniqueSecrets) {
    text = text.split(secret).join("<redacted-token>");
  }
  return text
    .replace(/mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu, "<redacted-api-key>")
    .replace(/(^|[\s"'=:(])((?:\/(?:Users|home|root|private|var|tmp|opt|usr|Volumes)\/)[^\s"',)\]}]+)/g, "$1<local-path>")
    .replace(/(^|[\s"'=:(])([A-Za-z]:[\\/][^\s"',)\]}]+)/g, "$1<local-path>")
    .replace(/\b(X-Meshrix-Api-Key\s*:\s*)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/(^|[\s"'=:(])(--token(?:=|\s+))[^\s"',;)\]}]+/gi, "$1$2<redacted-token>")
    .replace(/\b(token|access_token|refresh_token|api_key|apiKey|secret|password)=([^\s"',;)\]}]+)/gi, "$1=<redacted-secret>");
}

export function redactInstallerJsonOutput(value?: any) : any {
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => redactInstallerJsonOutput(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      (Object.entries(value) as [string, any][]).map(([key, child]: any[]) : any => [key, redactInstallerJsonOutput(child)])
    );
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  return value;
}

export function sensitiveOptionValues(options: Record<string, any> = {}) : any {
  const tokenEnv: any = String(option(options, "token-env", DEFAULT_TOKEN_ENV));
  const envToken: any = String(process.env[tokenEnv] || "").trim();
  return envToken ? [envToken] : [];
}
