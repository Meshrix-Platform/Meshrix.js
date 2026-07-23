import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { createConsoleAuth } from "../../packages/foundation/src/security/auth/console-auth.mjs";
import { createTagStoreAdapter } from "../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";
import { ServerConfig } from "#lico/server-config";

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function usage() {
  console.log(`LicoMesh Console Auth

Usage:
  npm run server:auth -- list-users
  npm run server:auth -- create-user --username USER --role viewer --generate-password
  npm run server:auth -- set-password --username USER --generate-password
  npm run server:auth -- set-role --username USER --role operator
  npm run server:auth -- set-tenant --username USER --tenant-id TENANT [--workspace-ids w1,w2]
  npm run server:auth -- enable --username USER
  npm run server:auth -- disable --username USER

Options:
  --data-dir PATH        Defaults to ServerConfig.getDataDir()
  --username USER
  --user-id USER_ID
  --display-name NAME
  --role owner|admin|operator|viewer
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

function requireValue(args, key) {
  const value = String(args[key] || "").trim();
  if (!value) {
    throw new Error(`缺少 --${key}`);
  }
  return value;
}

function randomPassword() {
  return `sap_${crypto.randomBytes(24).toString("base64url")}`;
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "";
  if (!command || command === "help" || args.help) {
    usage();
    return;
  }

  const userDataPath = path.resolve(
    String(args["data-dir"] || process.env.LICO_SERVER_DATA_DIR || ServerConfig.getDataDir())
  );
  const tagManagementStore = createTagStoreAdapter({ userDataPath });
  const auth = createConsoleAuth({ userDataPath, tagManagementStore });

  try {
    if (command === "init-owner") {
      const result = await auth.ensureInitialOwner();
      if (result.created) {
        console.log(`created owner: ${result.username}`);
        console.log(`initial password: ${result.password}`);
        return;
      }
      console.log("owner already initialized");
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
      const password = args["generate-password"]
        ? randomPassword()
        : requireValue(args, "password");
      const user = await auth.createUser({
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

    const targetUser =
      String(args["user-id"] || "").trim()
        ? auth.listUsers().find((user) => user.userId === String(args["user-id"]).trim())
        : auth.listUsers().find((user) => user.username === requireValue(args, "username").toLowerCase());
    if (!targetUser) {
      throw new Error("用户不存在。");
    }

    if (command === "set-password") {
      const password = args["generate-password"]
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
      const roleId = requireValue(args, "role");
      const user = await auth.updateUser(targetUser.userId, { roleId });
      console.log(`role updated: ${user.username} -> ${user.roleId}`);
      return;
    }

    if (command === "set-tenant") {
      const user = await auth.updateUser(targetUser.userId, {
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
      const user = await auth.updateUser(targetUser.userId, { enabled: command === "enable" });
      console.log(`${command}d user: ${user.username}`);
      return;
    }

    throw new Error(`未知命令：${command}`);
  } finally {
    auth.close();
    tagManagementStore.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
