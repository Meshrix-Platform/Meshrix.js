import { DEFAULT_TOKEN_ENV } from "./constants.mjs";
import { option } from "./basic-utils.mjs";

export function redactToken(value) {
  const text = String(value || "");
  if (text.length <= 12) {
    return "***";
  }
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

export function redactSensitiveText(value, secrets = []) {
  let text = String(value || "");
  const uniqueSecrets = new Set(
    secrets.map((item) => String(item || "")).filter((item) => item.length > 0)
  );
  for (const secret of uniqueSecrets) {
    text = text.split(secret).join("<redacted-token>");
  }
  return text
    .replace(/(^|[\s"'=:(])((?:\/(?:Users|home|root|private|var|tmp|opt|usr|Volumes)\/)[^\s"',)\]}]+)/g, "$1<local-path>")
    .replace(/(^|[\s"'=:(])([A-Za-z]:[\\/][^\s"',)\]}]+)/g, "$1<local-path>")
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/\b(X-LicoMesh-Api-Key\s*:\s*)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/\b(x-lico-tool-token\s*:\s*)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/(^|[\s"'=:(])(--token(?:=|\s+))[^\s"',;)\]}]+/gi, "$1$2<redacted-token>")
    .replace(/\b(token|access_token|refresh_token|api_key|apiKey|secret|password)=([^\s"',;)\]}]+)/gi, "$1=<redacted-secret>");
}

export function redactInstallerJsonOutput(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactInstallerJsonOutput(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactInstallerJsonOutput(child)])
    );
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  return value;
}

export function sensitiveOptionValues(options = {}) {
  const tokenEnv = String(option(options, "token-env", DEFAULT_TOKEN_ENV));
  const envToken = String(process.env[tokenEnv] || "").trim();
  return envToken ? [envToken] : [];
}
