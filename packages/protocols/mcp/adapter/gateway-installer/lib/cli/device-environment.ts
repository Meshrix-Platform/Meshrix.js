import { containsMxak1Credential } from "./basic-utils.ts";
import { run } from "./connector-process.ts";
import {
  MESHRIX_MCP_DISCOVERY_FILE_ENV,
  MESHRIX_MCP_DISCOVERY_URL_ENV,
  MESHRIX_MCP_URL_ENV
} from "./constants.ts";

const DEVICE_DISCOVERY_ENV_NAMES = Object.freeze([
  MESHRIX_MCP_URL_ENV,
  MESHRIX_MCP_DISCOVERY_URL_ENV,
  MESHRIX_MCP_DISCOVERY_FILE_ENV
]);

const WINDOWS_READ_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$names = @('MESHRIX_MCP_URL', 'MESHRIX_MCP_DISCOVERY_URL', 'MESHRIX_MCP_DISCOVERY_FILE')",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  "$values = [ordered]@{}",
  "if ($null -ne $key) {",
  "  foreach ($name in $names) {",
  "    $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "    if ($null -ne $value) { $values[$name] = [string]$value }",
  "  }",
  "  $key.Close()",
  "}",
  "ConvertTo-Json -InputObject $values -Compress"
].join("\n");

const WINDOWS_WRITE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$names = @('MESHRIX_MCP_URL', 'MESHRIX_MCP_DISCOVERY_URL', 'MESHRIX_MCP_DISCOVERY_FILE')",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "if ($null -eq $key) { throw 'Environment registry key unavailable' }",
  "foreach ($name in $names) {",
  "  $value = [Environment]::GetEnvironmentVariable($name, 'Process')",
  "  if ($null -eq $value) { throw 'Required Meshrix discovery value unavailable' }",
  "  $key.SetValue($name, $value, [Microsoft.Win32.RegistryValueKind]::String)",
  "}",
  "$key.Close()"
].join("\n");

const WINDOWS_REMOVE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$names = @('MESHRIX_MCP_URL', 'MESHRIX_MCP_DISCOVERY_URL', 'MESHRIX_MCP_DISCOVERY_FILE')",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
  "if ($null -ne $key) {",
  "  foreach ($name in $names) {",
  "    if ($null -ne $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) {",
  "      $key.DeleteValue($name, $false)",
  "    }",
  "  }",
  "  $key.Close()",
  "}"
].join("\n");

interface DeviceEnvironmentOptions {
  platform?: NodeJS.Platform | string;
  runCommand?: typeof run;
}

export interface DeviceEnvironmentResult {
  supported: boolean;
  persisted: boolean;
  reason?: "disabled" | "unsupported-platform";
}

export interface DeviceEnvironmentPort {
  read(): Promise<Record<string, string>>;
  write(values: Record<string, unknown>): Promise<DeviceEnvironmentResult>;
  remove(): Promise<DeviceEnvironmentResult>;
}

export function disabledDeviceEnvironmentResult(platform = process.platform): DeviceEnvironmentResult {
  const supported = platform === "darwin" || platform === "win32";
  return {
    supported,
    persisted: false,
    reason: supported ? "disabled" : "unsupported-platform"
  };
}

function assertOwnedValues(values: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!DEVICE_DISCOVERY_ENV_NAMES.includes(name as typeof DEVICE_DISCOVERY_ENV_NAMES[number])) {
      throw new Error("device_environment_key_not_owned");
    }
    if (typeof value !== "string" || value.includes("\0") || containsMxak1Credential(value)) {
      throw new Error("device_environment_value_invalid");
    }
    result[name] = value;
  }
  return result;
}

function parseWindowsEnvironment(stdout: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || "{}");
  } catch {
    throw new Error("device_environment_read_failed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("device_environment_read_failed");
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!DEVICE_DISCOVERY_ENV_NAMES.includes(name as typeof DEVICE_DISCOVERY_ENV_NAMES[number]) || typeof value !== "string") {
      throw new Error("device_environment_read_failed");
    }
    result[name] = assertOwnedValues({ [name]: value })[name];
  }
  return result;
}

export function createDeviceEnvironmentPort({
  platform = process.platform,
  runCommand = run
}: DeviceEnvironmentOptions = {}): DeviceEnvironmentPort {
  const unsupported = (): DeviceEnvironmentResult => ({
    supported: false,
    persisted: false,
    reason: "unsupported-platform"
  });

  return {
    async read(): Promise<Record<string, string>> {
      if (platform === "linux") return {};
      if (platform === "darwin") {
        const pairs = await Promise.all(DEVICE_DISCOVERY_ENV_NAMES.map(async (name) => {
          const result = await runCommand("launchctl", ["getenv", name], { allowFailure: true });
          if (!result.ok) throw new Error("device_environment_read_failed");
          const value = String(result.stdout || "").trim();
          return value ? [name, assertOwnedValues({ [name]: value })[name]] as const : null;
        }));
        return Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair !== null));
      }
      if (platform === "win32") {
        const result = await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_READ_SCRIPT], {
          allowFailure: true
        });
        if (!result.ok) throw new Error("device_environment_read_failed");
        return parseWindowsEnvironment(String(result.stdout || ""));
      }
      return {};
    },

    async write(values: Record<string, unknown>): Promise<DeviceEnvironmentResult> {
      const ownedValues = assertOwnedValues(values);
      if (DEVICE_DISCOVERY_ENV_NAMES.some((name) => !Object.hasOwn(ownedValues, name))) {
        throw new Error("device_environment_values_incomplete");
      }
      if (platform !== "darwin" && platform !== "win32") return unsupported();
      if (platform === "darwin") {
        for (const [name, value] of Object.entries(ownedValues)) {
          const result = await runCommand("launchctl", ["setenv", name, value], { allowFailure: true });
          if (!result.ok) throw new Error("device_environment_write_failed");
        }
        return { supported: true, persisted: true };
      }
      const result = await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_WRITE_SCRIPT], {
        env: ownedValues,
        allowFailure: true
      });
      if (!result.ok) throw new Error("device_environment_write_failed");
      return { supported: true, persisted: true };
    },

    async remove(): Promise<DeviceEnvironmentResult> {
      if (platform !== "darwin" && platform !== "win32") return unsupported();
      if (platform === "darwin") {
        const currentValues = await this.read();
        for (const name of DEVICE_DISCOVERY_ENV_NAMES) {
          if (!Object.hasOwn(currentValues, name)) continue;
          const result = await runCommand("launchctl", ["unsetenv", name], { allowFailure: true });
          if (!result.ok) throw new Error("device_environment_remove_failed");
        }
        return { supported: true, persisted: true };
      }
        const result = await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_REMOVE_SCRIPT], {
          allowFailure: true
      });
      if (!result.ok) throw new Error("device_environment_remove_failed");
      return { supported: true, persisted: true };
    }
  };
}

export const deviceEnvironmentPort = createDeviceEnvironmentPort();
