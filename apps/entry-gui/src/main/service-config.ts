import { readFile } from "node:fs/promises";

import { normalizeAccountOrigin } from "./account-client.ts";
import { normalizeRelayBase } from "./relay-address.ts";

export const ENTRY_SERVICE_CONFIG_SCHEMA = "meshrix-entry-service-config-1" as const;

export interface EntryServiceConfig {
  readonly schemaVersion: typeof ENTRY_SERVICE_CONFIG_SCHEMA;
  readonly accountOrigin: string;
  readonly relayService: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serviceConfigError(code: "service_config_invalid" | "service_config_missing" | "service_config_unavailable", message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function parseEntryServiceConfig(value: unknown): EntryServiceConfig {
  if (!isRecord(value)
    || value.schemaVersion !== ENTRY_SERVICE_CONFIG_SCHEMA
    || typeof value.accountOrigin !== "string"
    || typeof value.relayService !== "string") {
    throw serviceConfigError("service_config_invalid", "The installed Meshrix service configuration is missing or malformed.");
  }
  let accountOrigin: string;
  let relay: URL;
  try {
    accountOrigin = normalizeAccountOrigin(value.accountOrigin);
    relay = normalizeRelayBase(value.relayService);
  } catch {
    throw serviceConfigError("service_config_invalid", "The installed Meshrix service origins are invalid.");
  }
  if (relay.protocol !== "wss:") {
    throw serviceConfigError("service_config_invalid", "The installed Meshrix relay service must use WSS.");
  }
  return Object.freeze({
    schemaVersion: ENTRY_SERVICE_CONFIG_SCHEMA,
    accountOrigin,
    relayService: relay.toString().replace(/\/$/u, "")
  });
}

/** A missing artifact is permitted only for local development/test composition. */
export async function readEntryServiceConfig(path: string | undefined): Promise<EntryServiceConfig | null> {
  if (!path) return null;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw serviceConfigError("service_config_missing", "The installed Meshrix service configuration is missing. Reinstall the application package.");
    }
    throw serviceConfigError("service_config_unavailable", "The installed Meshrix service configuration cannot be read.");
  }
  try {
    return parseEntryServiceConfig(JSON.parse(text) as unknown);
  } catch (error) {
    if ((error as { code?: unknown }).code === "service_config_invalid") throw error;
    throw serviceConfigError("service_config_invalid", "The installed Meshrix service configuration is invalid.");
  }
}
