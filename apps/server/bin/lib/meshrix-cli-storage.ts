import path from "node:path";

import { restoreOfflineStorage } from "@meshrix/foundation/storage/restore-offline";

interface CliArguments extends Record<string, unknown> {
  _: string[];
}

interface CliFailure extends Error {
  code: string;
}

function cliFailure(code: string, message: string): CliFailure {
  const error = new Error(message) as CliFailure;
  error.code = code;
  return error;
}

function isFailure(value: unknown): value is Error & { code?: unknown } {
  return value instanceof Error;
}

function failureCode(error: unknown): string {
  if (!isFailure(error)) return "storage_restore_failed";
  const code = String(error.code || "");
  return /^(?:backup|storage)_[a-z0-9_]{1,80}$/u.test(code)
    ? code
    : "storage_restore_failed";
}

function writeFailure(error: unknown): void {
  console.log(JSON.stringify({
    ok: false,
    error: {
      code: failureCode(error),
      message: "Restore was not completed. Check the selected backup, data root, and runtime state."
    }
  }, null, 2));
  process.exitCode = 1;
}

function requiredString(args: CliArguments, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw cliFailure(`storage_${key.replace(/-/gu, "_")}_required`, `--${key} is required.`);
  }
  return value;
}

function requireBooleanFlag(args: CliArguments, key: string): boolean {
  const value = args[key];
  if (value === undefined) return false;
  if (value !== true) {
    throw cliFailure("storage_restore_flag_invalid", `--${key} does not accept a value.`);
  }
  return true;
}

function usage(): string {
  return [
    "Usage:",
    "  meshrix storage restore --data-dir PATH --backup-id ID [--apply --confirm]",
    "",
    "Preview is the default and does not modify the selected data root.",
    "Apply requires both --apply and --confirm and refuses an active Meshrix runtime."
  ].join("\n");
}

/** Handles the stopped-instance storage restore command. */
export async function runStorageCommand(args: CliArguments): Promise<boolean> {
  if (args._?.[0] !== "storage") return false;

  try {
    if (args.help === true || args.h === true) {
      console.log(usage());
      return true;
    }
    if (args._.length !== 2 || args._[1] !== "restore") {
      throw cliFailure("storage_command_invalid", "Use `meshrix storage restore`.");
    }

    const apply = requireBooleanFlag(args, "apply");
    const confirm = requireBooleanFlag(args, "confirm");
    if (confirm && !apply) {
      throw cliFailure("storage_restore_confirmation_unexpected", "--confirm requires --apply.");
    }
    if (apply && !confirm) {
      throw cliFailure("storage_restore_confirmation_required", "--apply requires --confirm.");
    }

    const result = await restoreOfflineStorage({
      dataRoot: path.resolve(requiredString(args, "data-dir")),
      backupId: requiredString(args, "backup-id"),
      mode: apply ? "apply" : "preview",
      confirm
    });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } catch (error: unknown) {
    writeFailure(error);
  }
  return true;
}
