import { MCP_SERVER_NAME } from "./constants.ts";

export function mcpProbeSupported(result?: any) : any {
  const output: any = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  const normalized: any = output.replace(/\s+/g, " ").trim();
  const hasMcpSignal: any = /\bmcp\b/.test(normalized) || normalized.includes("model context protocol");
  if (!hasMcpSignal) {
    return false;
  }
  const negativePatterns: any[] = [
    /\bunknown (?:command|subcommand)\b/,
    /\bunrecognized (?:command|subcommand)\b/,
    /\bno such (?:command|subcommand)\b/,
    /\bcommand not found\b/,
    /\bnot (?:a )?recognized (?:as )?(?:a )?command\b/,
    /\binvalid choice\b.*\bmcp\b/,
    /\bno help topic\b.*\bmcp\b/,
    /\bmcp\b.*\b(?:does not exist|not found|not supported|unsupported)\b/,
    /\b(?:does not support|unsupported)\b.*\bmcp\b/
  ];
  if (negativePatterns.some((pattern?: any) : any => pattern.test(normalized))) {
    return false;
  }
  const positivePatterns: any[] = [
    /\busage:\s*[^\r\n]*\bmcp\b/,
    /\bcommands?:\b/,
    /\bmcp\b.{0,120}\b(?:add|remove|list|get|enable|disable|login|logout|auth|server|configuration|protocol)\b/,
    /\bmanage\b.{0,80}\bmcp\b/,
    /\bmodel context protocol\b/
  ];
  return positivePatterns.some((pattern?: any) : any => pattern.test(normalized)) || Boolean(result.ok);
}

export function mcpOutputHasMeshrix(result?: any) : any {
  const output: any = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  return new RegExp(`(^|[^a-z0-9_-])${MCP_SERVER_NAME}([^a-z0-9_-]|$)`, "i").test(output);
}
