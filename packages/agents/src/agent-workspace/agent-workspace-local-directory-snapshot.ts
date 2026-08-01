import fs from "node:fs";
import path from "node:path";
import { assertPathWithinRootSync } from "@meshrix/foundation/security/local-path-boundary";
import {
  WORKSPACE_FILE_MAX_BYTES,
  asArray,
  normalizeSha256,
  normalizeWorkspaceRelativePath,
  sha256Buffer,
  stableHash
} from "./agent-workspace-support.ts";
import { workspaceIntegerLimit } from "./agent-workspace-limits.ts";
import {
  ensureDirectorySafely,
  readOrdinaryFileNoFollow,
  removePathSafely,
  renamePathSafely,
  writeFileAtomically
} from "./agent-workspace-local-directory-safe-fs.ts";

export const LOCAL_DIRECTORY_PREIMAGE_PROTOCOL_VERSION: any = "v0.0.1:workspace:local-directory-preimage-1";
export const LOCAL_DIRECTORY_PREIMAGE_MAX_BYTES: any = workspaceIntegerLimit(
  "MESHRIX_AGENT_WORKSPACE_LOCAL_PREIMAGE_MAX_BYTES",
  {
    defaultValue: 64 * 1024 * 1024,
    minimum: WORKSPACE_FILE_MAX_BYTES,
    maximum: 512 * 1024 * 1024
  }
);
export const LOCAL_DIRECTORY_PREIMAGE_MAX_ENTRIES: any = workspaceIntegerLimit(
  "MESHRIX_AGENT_WORKSPACE_LOCAL_PREIMAGE_MAX_ENTRIES",
  { defaultValue: 5000, minimum: 1, maximum: 20000 }
);
export const LOCAL_DIRECTORY_PREIMAGE_MAX_ROOTS: any = 8;

function localSnapshotError(code?: any, message?: any, status: any = 400) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isPathWithin(relativePath?: any, rootPath?: any) : any {
  return relativePath === rootPath || relativePath.startsWith(`${rootPath}/`);
}

function dedupeRoots(values: any = []) : any {
  const roots: any = [...new Set<any>(values.map((value?: any) : any => normalizeWorkspaceRelativePath(value, { allowEmpty: false })))]
    .sort((left?: any, right?: any) : any => left.split("/").length - right.split("/").length || left.localeCompare(right));
  const deduped: any[] = [];
  for (const root of roots) {
    if (!deduped.some((parent?: any) : any => isPathWithin(root, parent))) {
      deduped.push(root);
    }
  }
  if (deduped.length > LOCAL_DIRECTORY_PREIMAGE_MAX_ROOTS) {
    throw localSnapshotError(
      "local_directory_preimage_root_limit",
      `本机目录 mutation 的恢复根数量超过限制：${LOCAL_DIRECTORY_PREIMAGE_MAX_ROOTS}。`,
      413
    );
  }
  return deduped;
}

function snapshotFingerprint(entries: any = []) : any {
  return stableHash(JSON.stringify(entries.map((entry?: any) : any => ({
    relativePath: entry.relativePath,
    state: entry.state,
    type: entry.type,
    sizeBytes: Number(entry.sizeBytes || 0),
    contentSha256: entry.contentSha256 || "",
    mode: Number(entry.mode || 0)
  }))));
}

function firstMissingAncestor(root?: any, relativePath?: any) : any {
  const segments: any = relativePath.split("/").filter(Boolean);
  for (let index: any = 0; index < segments.length; index += 1) {
    const candidateRelativePath: any = segments.slice(0, index + 1).join("/");
    const candidateAbsolutePath: any = path.resolve(root, ...candidateRelativePath.split("/"));
    if (!fs.existsSync(candidateAbsolutePath)) {
      return candidateRelativePath;
    }
    const stat: any = fs.lstatSync(candidateAbsolutePath);
    if (stat.isSymbolicLink()) {
      throw localSnapshotError(
        "local_directory_preimage_symlink",
        `本机目录 preimage 路径不能经过符号链接：${candidateRelativePath}。`
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw localSnapshotError(
        "local_directory_preimage_parent_not_directory",
        `本机目录 preimage 父路径不是目录：${candidateRelativePath}。`
      );
    }
  }
  return relativePath;
}

function publicSnapshotEntry(entry: Record<string, any> = {}) : any {
  return {
    relativePath: entry.relativePath,
    state: entry.state,
    type: entry.type,
    sizeBytes: Number(entry.sizeBytes || 0),
    contentCid: String(entry.contentCid || ""),
    contentSha256: String(entry.contentSha256 || ""),
    mode: Number(entry.mode || 0)
  };
}

function assertSnapshotWorkspaceBinding(workspace: Record<string, any> = {}, snapshot: Record<string, any> = {}) : any {
  if (snapshot.schemaVersion !== LOCAL_DIRECTORY_PREIMAGE_PROTOCOL_VERSION) {
    throw localSnapshotError("local_directory_preimage_schema_invalid", "本机目录 preimage schemaVersion 无效。");
  }
  if (
    !String(snapshot.workspaceId || "") ||
    String(snapshot.workspaceId) !== String(workspace.workspaceId || "")
  ) {
    throw localSnapshotError("local_directory_preimage_workspace_mismatch", "本机目录 preimage 与 workspace 不匹配。", 409);
  }
  if (!String(snapshot.mountRef || "")) {
    throw localSnapshotError("local_directory_preimage_mount_missing", "本机目录 preimage 缺少 mountRef。");
  }
}

export function createAgentWorkspaceLocalDirectorySnapshotApi({
  merkleState = null,
  resolveLocalDirectoryMountPath,
  mountMutationKey
}: Record<string, any> = {}) : any {
  function assertCasAvailable() : any {
    if (
      typeof merkleState?.cas?.putBlock !== "function" ||
      typeof merkleState?.cas?.getBlock !== "function"
    ) {
      throw localSnapshotError(
        "local_directory_preimage_unavailable",
        "本机目录 mutation 需要可用的 CAS preimage 存储。",
        503
      );
    }
  }

  function resolveSnapshotPath(workspace?: any, mountRef?: any, relativePath?: any, options: Record<string, any> = {}) : any {
    return resolveLocalDirectoryMountPath({ mountRef, path: relativePath }, workspace, {
      allowEmpty: false,
      allowMissing: options.allowMissing !== false,
      requireExisting: options.requireExisting === true,
      allowDirectory: true,
      allowFile: true
    });
  }

  async function scanRoots({ workspace, mountRef, roots, archive = false, operationId = "" }: Record<string, any> = {}) : Promise<any> {
    if (archive) {
      assertCasAvailable();
    }
    const entries: any[] = [];
    let totalBytes: any = 0;
    const pushEntry: any = (entry?: any) : any => {
      if (entries.length >= LOCAL_DIRECTORY_PREIMAGE_MAX_ENTRIES) {
        throw localSnapshotError(
          "local_directory_preimage_entry_limit",
          `本机目录 preimage 条目数量超过限制：${LOCAL_DIRECTORY_PREIMAGE_MAX_ENTRIES}。`,
          413
        );
      }
      entries.push(entry);
    };
    const visit: any = async (resolvedRoot?: any, absolutePath?: any, relativePath?: any) : Promise<any> => {
      const bounded: any = assertPathWithinRootSync(resolvedRoot.root, absolutePath, {
        label: "本机目录 preimage 路径",
        allowMissing: false,
        requireExisting: true,
        allowDirectory: true,
        allowFile: true,
        allowSpecial: false
      });
      const stat: any = fs.lstatSync(bounded.absolutePath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw localSnapshotError(
          "local_directory_preimage_special_file",
          `本机目录 preimage 只支持普通文件或目录：${relativePath}。`
        );
      }
      if (stat.isDirectory()) {
        pushEntry({
          relativePath,
          state: "exists",
          type: "directory",
          sizeBytes: 0,
          contentCid: "",
          contentSha256: "",
          mode: stat.mode & 0o777
        });
        const children: any = fs.readdirSync(bounded.absolutePath, { withFileTypes: true })
          .sort((left?: any, right?: any) : any => left.name.localeCompare(right.name));
        for (const child of children) {
          if (child.name.startsWith(".")) {
            throw localSnapshotError(
              "local_directory_preimage_hidden_path",
              `本机目录 preimage 不允许以 . 开头的路径：${relativePath}/${child.name}。`
            );
          }
          const childRelativePath: any = `${relativePath}/${child.name}`;
          await visit(resolvedRoot, path.join(bounded.absolutePath, child.name), childRelativePath);
        }
        return;
      }
      const { content, stat: fileStat } = readOrdinaryFileNoFollow(resolvedRoot.root, bounded.absolutePath, {
        maximumBytes: WORKSPACE_FILE_MAX_BYTES,
        errorPrefix: "local_directory_preimage_file"
      });
      totalBytes += content.length;
      if (totalBytes > LOCAL_DIRECTORY_PREIMAGE_MAX_BYTES) {
        throw localSnapshotError(
          "local_directory_preimage_total_limit",
          `本机目录 preimage 内容总量超过限制：${LOCAL_DIRECTORY_PREIMAGE_MAX_BYTES} bytes。`,
          413
        );
      }
      const contentSha256: any = sha256Buffer(content);
      let contentCid: any = "";
      if (archive) {
        const block: any = await merkleState.cas.putBlock(content, {
          codec: "raw",
          metadata: {
            workspaceId: workspace.workspaceId,
            mountRef,
            relativePath,
            operationId,
            localDirectoryPreimage: true
          }
        });
        if (normalizeSha256(block.payloadHash) !== normalizeSha256(contentSha256)) {
          throw localSnapshotError(
            "local_directory_preimage_cas_hash_mismatch",
            `本机目录 preimage CAS hash 不匹配：${relativePath}。`,
            409
          );
        }
        contentCid = block.cid;
      }
      pushEntry({
        relativePath,
        state: "exists",
        type: "file",
        sizeBytes: content.length,
        contentCid,
        contentSha256,
        mode: fileStat.mode & 0o777
      });
    };

    for (const root of roots) {
      const resolved: any = resolveSnapshotPath(workspace, mountRef, root, { allowMissing: true });
      if (!resolved.exists) {
        pushEntry({
          relativePath: root,
          state: "missing",
          type: "missing",
          sizeBytes: 0,
          contentCid: "",
          contentSha256: "",
          mode: 0
        });
        continue;
      }
      await visit(resolved, resolved.absolutePath, root);
    }
    entries.sort((left?: any, right?: any) : any => left.relativePath.localeCompare(right.relativePath));
    return {
      entries,
      totalBytes,
      fingerprint: snapshotFingerprint(entries)
    };
  }

  async function captureLocalDirectoryPreimage({
    workspace,
    input = {},
    relativePaths = [],
    operationId = "",
    fixedRoots = false
  }: Record<string, any> = {}) : Promise<any> {
    assertCasAvailable();
    const requested: any = asArray(relativePaths).map((value?: any) : any =>
      normalizeWorkspaceRelativePath(value, { allowEmpty: false })
    );
    if (requested.length === 0) {
      throw localSnapshotError("local_directory_preimage_paths_missing", "本机目录 preimage 缺少恢复路径。");
    }
    const resolvedPaths: any = requested.map((relativePath?: any) : any =>
      resolveLocalDirectoryMountPath({ ...input, path: relativePath }, workspace, {
        allowEmpty: false,
        allowMissing: true,
        allowDirectory: true,
        allowFile: true
      })
    );
    const mountRefs: any[] = [...new Set<any>(resolvedPaths.map((resolved?: any) : any => String(resolved.mount?.mountRef || "")))];
    if (mountRefs.length !== 1 || !mountRefs[0]) {
      throw localSnapshotError("local_directory_preimage_mount_mismatch", "本机目录 preimage 必须绑定一个 mountRef。");
    }
    const mountRef: any = mountRefs[0];
    const mountRoots: any[] = [...new Set<any>(resolvedPaths.map((resolved?: any) : any => resolved.root))];
    if (mountRoots.length !== 1) {
      throw localSnapshotError("local_directory_preimage_mount_root_mismatch", "本机目录 preimage mount root 不一致。", 409);
    }
    const roots: any = dedupeRoots(resolvedPaths.map((resolved?: any) : any =>
      fixedRoots || resolved.exists
        ? resolved.relativePath
        : firstMissingAncestor(resolved.root, resolved.relativePath)
    ));
    const scanned: any = await scanRoots({ workspace, mountRef, roots, archive: true, operationId });
    const snapshot: Record<string, any> = {
      schemaVersion: LOCAL_DIRECTORY_PREIMAGE_PROTOCOL_VERSION,
      workspaceId: workspace.workspaceId,
      mountRef,
      mountIdentityHash: stableHash(mountRoots[0]),
      roots,
      entries: scanned.entries.map(publicSnapshotEntry),
      totalBytes: scanned.totalBytes,
      entryCount: scanned.entries.length,
      fingerprint: scanned.fingerprint
    };
    return { snapshot };
  }

  async function validateLocalDirectoryPreimage({ workspace, capture }: Record<string, any> = {}) : Promise<any> {
    const snapshot: any = capture?.snapshot || capture;
    assertSnapshotWorkspaceBinding(workspace, snapshot);
    const resolvedIdentity: any = resolveSnapshotPath(workspace, snapshot.mountRef, dedupeRoots(snapshot.roots)[0], { allowMissing: true });
    if (snapshot.mountIdentityHash && stableHash(resolvedIdentity.root) !== snapshot.mountIdentityHash) {
      throw localSnapshotError("local_directory_preimage_mount_rebound", "本机目录 mount 在 preimage 后发生重新绑定。", 409);
    }
    const scanned: any = await scanRoots({
      workspace,
      mountRef: snapshot.mountRef,
      roots: dedupeRoots(snapshot.roots),
      archive: false
    });
    if (scanned.fingerprint !== snapshot.fingerprint) {
      throw localSnapshotError(
        "local_directory_preimage_changed",
        "本机目录状态在 preimage 与 mutation 之间发生变化。",
        409
      );
    }
    return true;
  }

  async function materializeSnapshot(snapshot: Record<string, any> = {}) : Promise<any> {
    assertCasAvailable();
    if (snapshot.schemaVersion !== LOCAL_DIRECTORY_PREIMAGE_PROTOCOL_VERSION) {
      throw localSnapshotError("local_directory_preimage_schema_invalid", "本机目录 preimage schemaVersion 无效。");
    }
    const roots: any = dedupeRoots(snapshot.roots);
    const rawEntries: any = asArray(snapshot.entries);
    if (
      rawEntries.length === 0 ||
      rawEntries.length > LOCAL_DIRECTORY_PREIMAGE_MAX_ENTRIES ||
      Number(snapshot.entryCount) !== rawEntries.length
    ) {
      throw localSnapshotError("local_directory_preimage_entry_count_invalid", "本机目录 preimage entryCount 无效。", 409);
    }
    const entries: any[] = [];
    const seenPaths: any = new Set<any>();
    let totalBytes: any = 0;
    for (const rawEntry of rawEntries) {
      const entry: any = publicSnapshotEntry({
        ...rawEntry,
        relativePath: normalizeWorkspaceRelativePath(rawEntry.relativePath || rawEntry.path || "", { allowEmpty: false })
      });
      if (seenPaths.has(entry.relativePath)) {
        throw localSnapshotError("local_directory_preimage_entry_duplicate", "本机目录 preimage 包含重复路径。", 409);
      }
      seenPaths.add(entry.relativePath);
      if (!roots.some((root?: any) : any => isPathWithin(entry.relativePath, root))) {
        throw localSnapshotError("local_directory_preimage_entry_outside_root", "本机目录 preimage 条目超出恢复根。");
      }
      if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
        throw localSnapshotError("local_directory_preimage_mode_invalid", "本机目录 preimage mode 无效。", 409);
      }
      if (entry.state === "missing") {
        if (entry.type !== "missing" || entry.sizeBytes !== 0 || entry.contentCid || entry.contentSha256) {
          throw localSnapshotError("local_directory_preimage_missing_entry_invalid", "本机目录 preimage missing 条目无效。", 409);
        }
        entries.push({ ...entry, content: Buffer.alloc(0) });
        continue;
      }
      if (entry.state !== "exists" || !["file", "directory"].includes(entry.type)) {
        throw localSnapshotError("local_directory_preimage_entry_type_invalid", "本机目录 preimage 条目类型无效。");
      }
      if (entry.type === "directory") {
        if (entry.sizeBytes !== 0 || entry.contentCid || entry.contentSha256) {
          throw localSnapshotError("local_directory_preimage_directory_entry_invalid", "本机目录 preimage directory 条目无效。", 409);
        }
        entries.push({ ...entry, content: Buffer.alloc(0) });
        continue;
      }
      if (
        !Number.isSafeInteger(entry.sizeBytes) ||
        entry.sizeBytes < 0 ||
        entry.sizeBytes > WORKSPACE_FILE_MAX_BYTES ||
        !entry.contentCid ||
        entry.contentCid.length > 256 ||
        !/^[a-f0-9]{64}$/u.test(normalizeSha256(entry.contentSha256))
      ) {
        throw localSnapshotError("local_directory_preimage_file_entry_invalid", "本机目录 preimage file 条目无效。", 409);
      }
      const block: any = await merkleState.cas.getBlock(entry.contentCid);
      if (!block) {
        throw localSnapshotError("local_directory_preimage_content_missing", "本机目录 preimage CAS 内容不存在。", 409);
      }
      const content: any = block.bytes;
      const contentSha256: any = sha256Buffer(content);
      if (
        normalizeSha256(contentSha256) !== normalizeSha256(entry.contentSha256) ||
        content.length !== entry.sizeBytes
      ) {
        throw localSnapshotError("local_directory_preimage_content_mismatch", "本机目录 preimage CAS 内容校验失败。", 409);
      }
      totalBytes += content.length;
      if (totalBytes > LOCAL_DIRECTORY_PREIMAGE_MAX_BYTES) {
        throw localSnapshotError("local_directory_preimage_total_limit", "本机目录 preimage 恢复内容超过大小限制。", 413);
      }
      entries.push({ ...entry, content });
    }
    if (Number(snapshot.totalBytes) !== totalBytes) {
      throw localSnapshotError("local_directory_preimage_total_bytes_mismatch", "本机目录 preimage totalBytes 校验失败。", 409);
    }
    const publicEntries: any = entries.map(publicSnapshotEntry).sort((left?: any, right?: any) : any => left.relativePath.localeCompare(right.relativePath));
    if (snapshotFingerprint(publicEntries) !== snapshot.fingerprint) {
      throw localSnapshotError("local_directory_preimage_fingerprint_mismatch", "本机目录 preimage fingerprint 校验失败。", 409);
    }
    return entries.sort((left?: any, right?: any) : any => left.relativePath.localeCompare(right.relativePath));
  }

  async function applySnapshot({ workspace, snapshot, entries = null }: Record<string, any> = {}) : Promise<any> {
    const materialized: any = entries || await materializeSnapshot(snapshot);
    const roots: any = dedupeRoots(snapshot.roots);
    for (const root of [...roots].sort((left?: any, right?: any) : any => right.length - left.length)) {
      const resolved: any = resolveSnapshotPath(workspace, snapshot.mountRef, root, { allowMissing: true });
      if (resolved.exists) {
        removePathSafely(resolved.root, resolved.absolutePath, { recursive: true });
      }
    }
    const existingEntries: any = materialized.filter((entry?: any) : any => entry.state !== "missing");
    const directories: any = existingEntries
      .filter((entry?: any) : any => entry.type === "directory")
      .sort((left?: any, right?: any) : any => left.relativePath.split("/").length - right.relativePath.split("/").length);
    for (const entry of directories) {
      const resolved: any = resolveSnapshotPath(workspace, snapshot.mountRef, entry.relativePath, { allowMissing: true });
      ensureDirectorySafely(resolved.root, resolved.absolutePath, Number(entry.mode || 0o700) & 0o777);
      fs.chmodSync(resolved.absolutePath, Number(entry.mode || 0o700) & 0o777);
    }
    for (const entry of existingEntries.filter((item?: any) : any => item.type === "file")) {
      const resolved: any = resolveSnapshotPath(workspace, snapshot.mountRef, entry.relativePath, { allowMissing: true });
      writeFileAtomically(resolved.root, resolved.absolutePath, entry.content, entry.mode, {
        preserveExecutable: true
      });
    }
    return materialized;
  }

  function planSnapshotActions(snapshot?: any, currentSnapshot?: any) : any {
    const desiredEntries: any = asArray(snapshot.entries).filter((entry?: any) : any => entry.state !== "missing");
    const currentEntries: any = asArray(currentSnapshot.entries).filter((entry?: any) : any => entry.state !== "missing");
    const desiredByPath: any = new Map<any, any>(desiredEntries.map((entry?: any) : any => [entry.relativePath, entry]));
    const currentByPath: any = new Map<any, any>(currentEntries.map((entry?: any) : any => [entry.relativePath, entry]));
    const actions: any[] = [];
    for (const current of currentEntries) {
      if (!desiredByPath.has(current.relativePath)) {
        actions.push({
          action: "delete",
          scope: "localDir",
          mountRef: snapshot.mountRef,
          path: current.relativePath,
          currentSha256: current.contentSha256 || ""
        });
      }
    }
    for (const desired of desiredEntries) {
      const current: any = currentByPath.get(desired.relativePath);
      const action: any = !current
        ? "create"
        : current.type !== desired.type
          ? "replace"
          : desired.type === "file" && current.contentSha256 !== desired.contentSha256
            ? "write"
            : "noop";
      actions.push({
        action,
        scope: "localDir",
        mountRef: snapshot.mountRef,
        path: desired.relativePath,
        expectedSha256: desired.contentSha256 || "",
        currentSha256: current?.contentSha256 || ""
      });
    }
    if (actions.length === 0) {
      for (const root of snapshot.roots) {
        actions.push({ action: "noop", scope: "localDir", mountRef: snapshot.mountRef, path: root });
      }
    }
    return actions.sort((left?: any, right?: any) : any => left.path.localeCompare(right.path) || left.action.localeCompare(right.action));
  }

  function stateProjectionForSnapshot(snapshot?: any, currentSnapshot: any = null) : any {
    const mutations: any[] = [];
    if (currentSnapshot) {
      for (const entry of [...asArray(currentSnapshot.entries)]
        .filter((item?: any) : any => item.state !== "missing")
        .sort((left?: any, right?: any) : any => right.relativePath.length - left.relativePath.length)) {
        mutations.push({ action: "delete", key: mountMutationKey(snapshot.mountRef, entry.relativePath) });
      }
    }
    for (const entry of asArray(snapshot.entries).filter((item?: any) : any => item.state !== "missing")) {
      mutations.push({
        action: "put",
        key: mountMutationKey(snapshot.mountRef, entry.relativePath),
        valueRef: entry.type === "file" ? entry.contentCid : "",
        metadata: entry.type === "file"
          ? { type: "file", sizeBytes: entry.sizeBytes, contentSha256: entry.contentSha256 }
          : { type: "directory", sizeBytes: 0 }
      });
    }
    return {
      mutations,
      contentRefs: asArray(snapshot.entries).map((entry?: any) : any => entry.contentCid).filter(Boolean)
    };
  }

  async function restoreLocalDirectoryPreimage({ workspace, snapshot, dryRun = false }: Record<string, any> = {}) : Promise<any> {
    assertSnapshotWorkspaceBinding(workspace, snapshot);
    const resolvedIdentity: any = resolveSnapshotPath(workspace, snapshot.mountRef, dedupeRoots(snapshot.roots)[0], { allowMissing: true });
    if (snapshot.mountIdentityHash && stableHash(resolvedIdentity.root) !== snapshot.mountIdentityHash) {
      throw localSnapshotError("local_directory_preimage_mount_rebound", "本机目录 mount 与 checkpoint 绑定不一致。", 409);
    }
    const desiredEntries: any = await materializeSnapshot(snapshot);
    let currentCapture: any;
    if (dryRun) {
      const scanned: any = await scanRoots({
        workspace,
        mountRef: snapshot.mountRef,
        roots: dedupeRoots(snapshot.roots),
        archive: false
      });
      currentCapture = {
        snapshot: {
          schemaVersion: LOCAL_DIRECTORY_PREIMAGE_PROTOCOL_VERSION,
          workspaceId: workspace.workspaceId,
          mountRef: snapshot.mountRef,
          mountIdentityHash: stableHash(resolvedIdentity.root),
          roots: dedupeRoots(snapshot.roots),
          entries: scanned.entries.map(publicSnapshotEntry),
          totalBytes: scanned.totalBytes,
          entryCount: scanned.entries.length,
          fingerprint: scanned.fingerprint
        }
      };
    } else {
      currentCapture = await captureLocalDirectoryPreimage({
        workspace,
        input: { mountRef: snapshot.mountRef },
        relativePaths: snapshot.roots,
        operationId: "workspace.checkpoint.restore.preimage",
        fixedRoots: true
      });
    }
    const actions: any = planSnapshotActions(snapshot, currentCapture.snapshot);
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        mountRef: snapshot.mountRef,
        actions,
        appliedActions: [],
        summary: {
          create: actions.filter((action?: any) : any => action.action === "create").length,
          write: actions.filter((action?: any) : any => action.action === "write" || action.action === "replace").length,
          delete: actions.filter((action?: any) : any => action.action === "delete").length,
          noop: actions.filter((action?: any) : any => action.action === "noop").length,
          applied: 0
        }
      };
    }
    await validateLocalDirectoryPreimage({ workspace, capture: currentCapture });
    try {
      await applySnapshot({ workspace, snapshot, entries: desiredEntries });
    } catch (error: any) {
      try {
        await applySnapshot({ workspace, snapshot: currentCapture.snapshot });
      } catch {
        throw localSnapshotError(
          "local_directory_restore_rollback_failed",
          "本机目录恢复失败，且无法恢复 apply 前状态。",
          500
        );
      }
      throw localSnapshotError(
        "local_directory_restore_apply_failed",
        "本机目录恢复未完成，已恢复 apply 前状态。",
        Number(error?.status || 500)
      );
    }
    const projection: any = stateProjectionForSnapshot(snapshot, currentCapture.snapshot);
    const appliedActions: any = actions.filter((action?: any) : any => action.action !== "noop");
    return {
      ok: true,
      dryRun: false,
      mountRef: snapshot.mountRef,
      actions,
      appliedActions,
      rollbackSnapshot: currentCapture.snapshot,
      stateMutations: projection.mutations,
      contentRefs: projection.contentRefs,
      summary: {
        create: actions.filter((action?: any) : any => action.action === "create").length,
        write: actions.filter((action?: any) : any => action.action === "write" || action.action === "replace").length,
        delete: actions.filter((action?: any) : any => action.action === "delete").length,
        noop: actions.filter((action?: any) : any => action.action === "noop").length,
        applied: appliedActions.length
      }
    };
  }

  async function rollbackLocalDirectoryMutation({ workspace, snapshot }: Record<string, any> = {}) : Promise<any> {
    assertSnapshotWorkspaceBinding(workspace, snapshot);
    const entries: any = await materializeSnapshot(snapshot);
    await applySnapshot({ workspace, snapshot, entries });
    return stateProjectionForSnapshot(snapshot);
  }

  function workspacePreimageSnapshot(snapshot?: any) : any {
    return {
      schemaVersion: "v0.0.1:workspace:file-restore-snapshot-1",
      workspaceId: snapshot.workspaceId,
      basePath: "",
      deleteExtraneous: false,
      files: [],
      localDirectorySnapshots: [snapshot]
    };
  }

  return {
    captureLocalDirectoryPreimage,
    validateLocalDirectoryPreimage,
    restoreLocalDirectoryPreimage,
    rollbackLocalDirectoryMutation,
    workspacePreimageSnapshot,
    stateProjectionForSnapshot,
    writeFileAtomically,
    ensureDirectorySafely,
    removePathSafely,
    renamePathSafely
  };
}
