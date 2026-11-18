import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

interface ServerConfiguration {
  dataDir?: string;
}

interface ConfigReadError extends Error {
  code: string;
}

function configuration(value: unknown): ServerConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const dataDir = Reflect.get(value, "dataDir");
  return typeof dataDir === "string" && dataDir.trim() ? { dataDir } : {};
}

class ServerConfigManager {
  config: ServerConfiguration;
  configPath: string;
  explicitConfigPath: boolean;
  constructor() {
    this.explicitConfigPath = Boolean(process.env.MESHRIX_CONFIG_FILE);
    this.configPath =
      process.env.MESHRIX_CONFIG_FILE || path.join(os.homedir(), ".meshrix-server.json");
    this.config = this.loadConfig();
  }

  loadConfig(): ServerConfiguration {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf8");
        return configuration(JSON.parse(raw));
      }
    } catch (err: unknown) {
      const errorCode = err && typeof err === "object" ? Reflect.get(err, "code") : null;
      const failureCode = typeof errorCode === "string" && errorCode
        ? errorCode
        : err instanceof SyntaxError
          ? "invalid_json"
          : "config_read_failed";
      console.warn(`[server-config] load failed code=${failureCode}`);
      if (this.explicitConfigPath && !process.env.MESHRIX_SERVER_DATA_DIR) {
        const error = new Error("Explicit Meshrix.js server config could not be read.") as ConfigReadError;
        error.code = "meshrix_server_config_read_failed";
        throw error;
      }
    }
    return {};
  }

  getDataDir(): string {
    return process.env.MESHRIX_SERVER_DATA_DIR || this.config.dataDir || path.join(os.homedir(), "meshrix-data");
  }
}

export const ServerConfig = new ServerConfigManager();
