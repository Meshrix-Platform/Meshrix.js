import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

class ServerConfigManager {
  config: any;
  configPath: any;
  explicitConfigPath: any;
  constructor() {
    this.explicitConfigPath = Boolean(process.env.MESHRIX_CONFIG_FILE);
    this.configPath =
      process.env.MESHRIX_CONFIG_FILE || path.join(os.homedir(), ".meshrix-server.json");
    this.config = this.loadConfig();
  }

  loadConfig() : any {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw: any = fs.readFileSync(this.configPath, "utf8");
        return JSON.parse(raw);
      }
    } catch (err: any) {
      const failureCode: any = typeof err?.code === "string" && err.code
        ? err.code
        : err instanceof SyntaxError
          ? "invalid_json"
          : "config_read_failed";
      console.warn(`[server-config] load failed code=${failureCode}`);
      if (this.explicitConfigPath && !process.env.MESHRIX_SERVER_DATA_DIR) {
        const error: Error & Record<string, any> = new Error("Explicit Meshrix server config could not be read.");
        error.code = "meshrix_server_config_read_failed";
        throw error;
      }
    }
    return {};
  }

  getDataDir() : any {
    return process.env.MESHRIX_SERVER_DATA_DIR || this.config.dataDir || path.join(os.homedir(), "meshrix-data");
  }
}

export const ServerConfig: any = new ServerConfigManager();
