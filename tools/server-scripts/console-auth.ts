import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONSOLE_ROLES,
  createConsoleAuth
} from "../../packages/foundation/src/security/auth/console-auth.ts";
import { createTagStoreAdapter } from "../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";
import { ServerConfig } from "#meshrix/server-config";

function parseArgs(argv?: any) : any {
  const parsed: Record<string, any> = { _: [] };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key: any = arg.slice(2);
    const next: any = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function usage() : any {
  console.log(`Meshrix.js Console Auth

Usage:
  npm run server:auth -- list-users
  npm run server:auth -- create-user --username USER --role viewer --generate-password
  npm run server:auth -- set-password --username USER --generate-password
  npm run server:auth -- set-role --username USER --role maintainer
  npm run server:auth -- set-tenant --username USER --tenant-id TENANT [--workspace-ids w1,w2]
  npm run server:auth -- enable --username USER
  npm run server:auth -- disable --username USER
  npm run server:auth -- init-owner --credential-stdin

Options:
  --data-dir PATH        Defaults to ServerConfig.getDataDir()
  --username USER
  --user-id USER_ID
  --display-name NAME
  --role owner|maintainer|viewer
  --tenant-id TENANT
  --org-id ORG
  --team-ids TEAM_A,TEAM_B
  --department-ids DEPT_A,DEPT_B
  --workspace-ids WORKSPACE_A,WORKSPACE_B
  --data-classes public,internal
  --egress searchResult,evidenceRead,exportFile
  --password PASSWORD
  --generate-password
`);
}

const MAX_OWNER_CREDENTIAL_BYTES: any = 8 * 1024;

export function parseInitialOwnerCredential(bytes?: Uint8Array) : any {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_OWNER_CREDENTIAL_BYTES) {
    throw new Error("initial_owner_credential_invalid");
  }
  let parsed: any;
  try {
    const text: any = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const jsonString: any = '"(?:\\\\["\\\\/bfnrt]|\\\\u[0-9a-fA-F]{4}|[^"\\\\\\u0000-\\u001F])*"';
    const closedObject: any = new RegExp(`^\\s*\\{\\s*${jsonString}\\s*:\\s*${jsonString}\\s*,\\s*${jsonString}\\s*:\\s*${jsonString}\\s*\\}\\s*$`, "u");
    if (!closedObject.test(text)) throw new Error("initial_owner_credential_invalid");
    parsed = JSON.parse(text);
  } catch {
    throw new Error("initial_owner_credential_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype ||
      JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(["password", "username"]) ||
      typeof parsed.username !== "string" || typeof parsed.password !== "string" ||
      parsed.username.trim().toLowerCase() !== "owner" ||
      parsed.password.length < 10 || parsed.password.length > 256) {
    throw new Error("initial_owner_credential_invalid");
  }
  return { username: parsed.username, password: parsed.password };
}

export async function readPrivateOwnerCredentialFile(inputPath?: unknown) : Promise<any> {
  const resolved: any = path.resolve(String(inputPath || ""));
  let handle: any;
  try {
    handle = await fs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats: any = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_OWNER_CREDENTIAL_BYTES ||
        (stats.mode & 0o777) !== 0o600) {
      throw new Error("initial_owner_credential_file_unsafe");
    }
    const bytes: any = Buffer.alloc(stats.size);
    try {
      const read: any = await handle.read(bytes, 0, stats.size, 0);
      const afterRead: any = await handle.stat();
      if (read.bytesRead !== stats.size || afterRead.size !== stats.size ||
          afterRead.mtimeMs !== stats.mtimeMs || afterRead.ctimeMs !== stats.ctimeMs ||
          (afterRead.mode & 0o777) !== 0o600) {
        throw new Error("initial_owner_credential_invalid");
      }
      return parseInitialOwnerCredential(bytes);
    } finally {
      bytes.fill(0);
    }
  } catch (error: any) {
    if (String(error?.message || "").startsWith("initial_owner_credential_")) throw error;
    throw new Error("initial_owner_credential_file_unsafe");
  } finally {
    await handle?.close?.();
  }
}

async function readInitialOwnerCredentialStdin() : Promise<any> {
  const chunks: any[] = [];
  let size: any = 0;
  for await (const chunk of process.stdin) {
    const bytes: any = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_OWNER_CREDENTIAL_BYTES) {
      for (const retained of chunks) retained.fill(0);
      bytes.fill(0);
      throw new Error("initial_owner_credential_too_large");
    }
    chunks.push(bytes);
  }
  const joined: any = Buffer.concat(chunks, size);
  for (const retained of chunks) retained.fill(0);
  try {
    return parseInitialOwnerCredential(joined);
  } finally {
    joined.fill(0);
  }
}

function requireValue(args?: any, key?: any) : any {
  const value: any = String(args[key] || "").trim();
  if (!value) {
    throw new Error(`缺少 --${key}`);
  }
  return value;
}

function randomPassword() : any {
  return `sap_${crypto.randomBytes(24).toString("base64url")}`;
}

function csv(value?: any) : any {
  return String(value || "")
    .split(",")
    .map((item?: any) : any => item.trim())
    .filter(Boolean);
}

async function main() : Promise<any> {
  const args: any = parseArgs(process.argv.slice(2));
  const command: any = args._[0] || "";
  if (!command || command === "help" || args.help) {
    usage();
    return;
  }

  const userDataPath: any = path.resolve(
    String(args["data-dir"] || process.env.MESHRIX_SERVER_DATA_DIR || ServerConfig.getDataDir())
  );
  const tagManagementStore: any = createTagStoreAdapter({ userDataPath });
  const auth: any = createConsoleAuth({
    userDataPath,
    consoleRoles: CONSOLE_ROLES,
    tagManagementStore
  });

  try {
    if (command === "init-owner") {
      const allowedKeys: any = new Set(["_", "credential-stdin", "data-dir"]);
      if (args["credential-stdin"] !== true || Object.keys(args).some((key?: any) : any => !allowedKeys.has(key))) {
        throw new Error("init_owner_requires_credential_stdin");
      }
      const credential: any = await readInitialOwnerCredentialStdin();
      let result: any;
      try {
        result = await auth.ensureInitialOwner(credential);
      } finally {
        credential.username = "";
        credential.password = "";
      }
      if (result.created) {
        console.log(JSON.stringify({ status: "created", reason: "initial_owner_created" }));
        return;
      }
      console.log(JSON.stringify({ status: "already-initialized", reason: "owner_exists" }));
      return;
    }

    if (command === "list-users") {
      for (const user of auth.listUsers()) {
        console.log(
          [
            user.userId,
            user.username,
            user.displayName,
            user.roleId,
            user.tenantId || "default",
            user.enabled ? "enabled" : "disabled",
            user.lastLoginAt || "never"
          ].join("\t")
        );
      }
      return;
    }

    if (command === "create-user") {
      const password: any = args["generate-password"]
        ? randomPassword()
        : requireValue(args, "password");
      const user: any = await auth.createUser({
        username: requireValue(args, "username"),
        displayName: String(args["display-name"] || args.username || "").trim(),
        password,
        roleId: String(args.role || "viewer").trim(),
        tenantId: String(args["tenant-id"] || "default").trim(),
        orgId: String(args["org-id"] || "").trim(),
        teamIds: csv(args["team-ids"]),
        departmentIds: csv(args["department-ids"]),
        allowedWorkspaceIds: csv(args["workspace-ids"]),
        allowedDataClasses: csv(args["data-classes"]),
        allowedEgress: csv(args.egress),
        enabled: true
      });
      console.log(`created user: ${user.username} (${user.roleId})`);
      if (args["generate-password"]) {
        console.log(`initial password: ${password}`);
      }
      return;
    }

    const targetUser: any =
      String(args["user-id"] || "").trim()
        ? auth.listUsers().find((user?: any) : any => user.userId === String(args["user-id"]).trim())
        : auth.listUsers().find((user?: any) : any => user.username === requireValue(args, "username").toLowerCase());
    if (!targetUser) {
      throw new Error("用户不存在。");
    }

    if (command === "set-password") {
      const password: any = args["generate-password"]
        ? randomPassword()
        : requireValue(args, "password");
      await auth.updateUser(targetUser.userId, { password });
      console.log(`password updated: ${targetUser.username}`);
      if (args["generate-password"]) {
        console.log(`new password: ${password}`);
      }
      return;
    }

    if (command === "set-role") {
      const roleId: any = requireValue(args, "role");
      const user: any = await auth.updateUser(targetUser.userId, { roleId });
      console.log(`role updated: ${user.username} -> ${user.roleId}`);
      return;
    }

    if (command === "set-tenant") {
      const user: any = await auth.updateUser(targetUser.userId, {
        tenantId: requireValue(args, "tenant-id"),
        ...(args["org-id"] !== undefined ? { orgId: String(args["org-id"] || "").trim() } : {}),
        ...(args["team-ids"] !== undefined ? { teamIds: csv(args["team-ids"]) } : {}),
        ...(args["department-ids"] !== undefined ? { departmentIds: csv(args["department-ids"]) } : {}),
        ...(args["workspace-ids"] !== undefined ? { allowedWorkspaceIds: csv(args["workspace-ids"]) } : {}),
        ...(args["data-classes"] !== undefined ? { allowedDataClasses: csv(args["data-classes"]) } : {}),
        ...(args.egress !== undefined ? { allowedEgress: csv(args.egress) } : {})
      });
      console.log(`tenant updated: ${user.username} -> ${user.tenantId}`);
      return;
    }

    if (command === "enable" || command === "disable") {
      const user: any = await auth.updateUser(targetUser.userId, { enabled: command === "enable" });
      console.log(`${command}d user: ${user.username}`);
      return;
    }

    throw new Error(`未知命令：${command}`);
  } finally {
    auth.close();
    tagManagementStore.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error?: any) : any => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
