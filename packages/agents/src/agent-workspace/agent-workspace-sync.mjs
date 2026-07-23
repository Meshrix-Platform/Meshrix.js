import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getRuntimeLogger } from "@lico/foundation/observability/runtime-logger";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  asArray,
  asObject,
  assertWorkspaceFileContentPolicy,
  fileMetadataFromStat,
  joinWorkspaceRelativePath,
  normalizeSha256,
  normalizeWorkspaceRelativePath,
  nowIso,
  sha256Buffer,
  stripExecutableMode
} from "./agent-workspace-support.mjs";

export function createAgentWorkspaceSyncApi({
  merkleState = null,
  workspaceForStorage,
  resolveWorkspacePath,
  resolveLocalDirectorySource,
  listWorkspaceFiles,
  updateWorkspaceTimeStmt,
  fileStateApi,
  restoreLocalDirectoryPreimage = null,
  rollbackLocalDirectoryMutation = null
} = {}) {
  const {
    decodeWorkspaceFileContent,
    filePayloadMetadata,
    archiveWorkspacePath,
    commitWorkspaceFileState,
    recordWorkspaceFileCheckpoint
  } = fileStateApi;

  function sandboxMutationOrigin(input = {}, { requireApproval = false } = {}) {
    const sandboxReceiptDigest = normalizeSha256(input.sandboxReceiptDigest || "");
    if (!sandboxReceiptDigest) return null;
    const sandboxBindings = asObject(input.sandboxBindings);
    const calculatedReceiptDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(sandboxBindings))
      .digest("hex");
    if (calculatedReceiptDigest !== sandboxReceiptDigest) {
      const error = new Error("Sandbox receipt binding does not match its declared digest.");
      error.code = "sandbox_receipt_binding_mismatch";
      error.status = 409;
      throw error;
    }
    const previewDigest = normalizeSha256(input.previewDigest || "");
    const approvalBindingDigest = normalizeSha256(input.approvalBindingDigest || "");
    if (requireApproval && (!previewDigest || !approvalBindingDigest)) {
      const error = new Error("Sandbox output commit requires preview and approval bindings.");
      error.code = "sandbox_output_approval_binding_required";
      error.status = 409;
      throw error;
    }
    return {
      kind: "controlled-sandbox-output",
      sandboxReceiptDigest,
      ...(previewDigest ? { previewDigest } : {}),
      ...(approvalBindingDigest ? { approvalBindingDigest } : {})
    };
  }

  function sandboxMutationReceipt({ mutationOrigin, preimage, stateCommit, checkpoint } = {}) {
    if (!mutationOrigin) return null;
    if (
      !preimage ||
      !stateCommit?.commitId ||
      !checkpoint?.nodeId ||
      !normalizeSha256(checkpoint.checkpointBindingDigest || "") ||
      !normalizeSha256(mutationOrigin.previewDigest || "") ||
      !normalizeSha256(mutationOrigin.approvalBindingDigest || "")
    ) {
      const error = new Error("Workspace sandbox mutation receipt could not be persisted with its transaction.");
      error.code = "workspace_sandbox_mutation_receipt_incomplete";
      error.status = 503;
      throw error;
    }
    const receipt = {
      schemaVersion: "v0.0.1:workspace:sandbox-mutation-receipt-1",
      sandboxReceiptDigest: mutationOrigin.sandboxReceiptDigest,
      previewDigest: mutationOrigin.previewDigest,
      approvalBindingDigest: mutationOrigin.approvalBindingDigest,
      preimageDigest: crypto.createHash("sha256").update(JSON.stringify(preimage)).digest("hex"),
      stateCommitId: stateCommit.commitId,
      stateCommitDigest: crypto.createHash("sha256").update(JSON.stringify(stateCommit)).digest("hex"),
      checkpointNodeId: checkpoint.nodeId,
      checkpointDigest: checkpoint.checkpointBindingDigest
    };
    return {
      ...receipt,
      receiptDigest: crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex")
    };
  }
  function scanDirectoryForWorkspaceSync(root, {
    rootRelativePath = "",
    maxFiles = 2000
  } = {}) {
    const resolvedRoot = path.resolve(root);
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error("本机目录不存在。");
    }
    const rootStat = fs.lstatSync(resolvedRoot);
    if (rootStat.isSymbolicLink()) {
      throw new Error("不允许同步符号链接目录。");
    }
    if (!rootStat.isDirectory()) {
      throw new Error("sourcePath 必须是本机目录。");
    }
    const files = [];
    const visit = (absoluteDir, relativeDir) => {
      const entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          throw new Error(`不允许同步以 . 开头的路径：${relativeDir ? `${relativeDir}/` : ""}${entry.name}`);
        }
        const childAbsolutePath = path.join(absoluteDir, entry.name);
        const childRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const stat = fs.lstatSync(childAbsolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`不允许同步符号链接：${childRelativePath}`);
        }
        if (stat.isDirectory()) {
          visit(childAbsolutePath, childRelativePath);
          continue;
        }
        if (!stat.isFile()) {
          throw new Error(`不支持同步非普通文件：${childRelativePath}`);
        }
        if (files.length >= maxFiles) {
          throw new Error(`同步文件数量超过限制：${maxFiles}`);
        }
        const targetRelativePath = rootRelativePath
          ? joinWorkspaceRelativePath(rootRelativePath, childRelativePath)
          : normalizeWorkspaceRelativePath(childRelativePath, { allowEmpty: false });
        assertWorkspaceFileContentPolicy({
          relativePath: targetRelativePath,
          sizeBytes: stat.size
        });
        const content = fs.readFileSync(childAbsolutePath);
        assertWorkspaceFileContentPolicy({
          relativePath: targetRelativePath,
          contentBuffer: content,
          sizeBytes: stat.size
        });
        files.push({
          sourceRelativePath: normalizeWorkspaceRelativePath(childRelativePath, { allowEmpty: false }),
          relativePath: targetRelativePath,
          absolutePath: childAbsolutePath,
          sizeBytes: Number(stat.size || 0),
          contentSha256: sha256Buffer(content)
        });
      }
    };
    visit(resolvedRoot, "");
    return files;
  }

  function scanWorkspaceFilesForSync(workspace, basePath = "", maxFiles = 2000) {
    const base = resolveWorkspacePath(workspace, basePath, { allowEmpty: true });
    if (!fs.existsSync(base.absolutePath)) {
      return [];
    }
    const stat = fs.lstatSync(base.absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error("工作空间同步目标不能是符号链接。");
    }
    if (!stat.isDirectory()) {
      throw new Error("工作空间同步目标必须是目录。");
    }
    const files = [];
    const visit = (absoluteDir, relativeDir) => {
      const entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const childAbsolutePath = path.join(absoluteDir, entry.name);
        const childRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const stat = fs.lstatSync(childAbsolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`工作空间内存在不允许同步的符号链接：${childRelativePath}`);
        }
        if (stat.isDirectory()) {
          visit(childAbsolutePath, childRelativePath);
          continue;
        }
        if (!stat.isFile()) {
          continue;
        }
        if (files.length >= maxFiles) {
          throw new Error(`工作空间同步文件数量超过限制：${maxFiles}`);
        }
        const normalizedPath = normalizeWorkspaceRelativePath(childRelativePath, { allowEmpty: false });
        const finalRelativePath = basePath ? joinWorkspaceRelativePath(basePath, normalizedPath) : normalizedPath;
        const content = fs.readFileSync(childAbsolutePath);
        assertWorkspaceFileContentPolicy({
          relativePath: finalRelativePath,
          contentBuffer: content,
          sizeBytes: stat.size
        });
        files.push({
          relativePath: finalRelativePath,
          sizeBytes: Number(stat.size || 0),
          contentSha256: sha256Buffer(content)
        });
      }
    };
    visit(base.absolutePath, "");
    return files;
  }

  function localDirectorySyncPlan(input = {}, options = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let source;
    try {
      source = resolveLocalDirectorySource(input, access.workspace, options);
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    const sourcePath = source.sourcePath;
    let targetPath;
    try {
      targetPath = normalizeWorkspaceRelativePath(input.targetPath || input.path || "", { allowEmpty: true });
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    const maxFiles = Math.max(1, Math.min(Number(input.maxFiles || input.limit || 2000), 10000));
    const deleteExtraneous = input.deleteExtraneous === true || input.prune === true;
    let sourceFiles, targetFiles;
    try {
      sourceFiles = scanDirectoryForWorkspaceSync(sourcePath, { rootRelativePath: targetPath, maxFiles });
      targetFiles = scanWorkspaceFilesForSync(access.workspace, targetPath, maxFiles);
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    const targetByPath = new Map(targetFiles.map((file) => [file.relativePath, file]));
    const sourceByPath = new Map(sourceFiles.map((file) => [file.relativePath, file]));
    const actions = [];
    for (const source of sourceFiles) {
      const current = targetByPath.get(source.relativePath);
      const action = !current
        ? "create"
        : current.contentSha256 === source.contentSha256
          ? "noop"
          : "write";
      actions.push({
        action,
        sourceRelativePath: source.sourceRelativePath,
        targetPath: source.relativePath,
        sizeBytes: source.sizeBytes,
        contentSha256: source.contentSha256
      });
    }
    if (deleteExtraneous) {
      for (const current of targetFiles) {
        if (!sourceByPath.has(current.relativePath)) {
          actions.push({
            action: "delete",
            targetPath: current.relativePath,
            sizeBytes: current.sizeBytes,
            contentSha256: current.contentSha256
          });
        }
      }
    }
    const changedActions = actions.filter((action) => action.action !== "noop");
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      dryRun: true,
      workspaceId: access.workspace.workspaceId,
      targetPath,
      mountRef: source.mount?.mountRef || "",
      deleteExtraneous,
      sourceFileCount: sourceFiles.length,
      targetFileCount: targetFiles.length,
      actions,
      summary: {
        create: actions.filter((action) => action.action === "create").length,
        write: actions.filter((action) => action.action === "write").length,
        delete: actions.filter((action) => action.action === "delete").length,
        noop: actions.filter((action) => action.action === "noop").length,
        changed: changedActions.length
      }
    };
  }

  async function applyLocalDirectorySync(input = {}) {
    const operationId = String(input.operationId || "").trim();
    if (!operationId) {
      return {
        ok: false,
        status: 400,
        code: "local_directory_operation_id_required",
        error: "Local-directory synchronization requires an explicit operationId."
      };
    }
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const plan = localDirectorySyncPlan(input);
    if (!plan.ok) {
      return plan;
    }
    if (input.dryRun === true) {
      return plan;
    }
    let source;
    try {
      source = resolveLocalDirectorySource(input, access.workspace);
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    const sourcePath = source.sourcePath;
    const sourceFiles = scanDirectoryForWorkspaceSync(sourcePath, {
      rootRelativePath: plan.targetPath,
      maxFiles: Math.max(1, Math.min(Number(input.maxFiles || input.limit || 2000), 10000))
    });
    const sourceByTarget = new Map(sourceFiles.map((file) => [file.relativePath, file]));
    const mutations = [];
    const contentRefs = [];
    const appliedActions = [];
    for (const action of plan.actions) {
      if (action.action === "noop") {
        continue;
      }
      const target = resolveWorkspacePath(access.workspace, action.targetPath, { allowEmpty: false });
      if (action.action === "delete") {
        if (fs.existsSync(target.absolutePath)) {
          fs.rmSync(target.absolutePath, { force: true });
        }
        mutations.push({ action: "delete", key: target.relativePath });
        appliedActions.push(action);
        continue;
      }
      const source = sourceByTarget.get(action.targetPath);
      if (!source) {
        return { ok: false, status: 409, error: `同步源文件消失：${action.sourceRelativePath || action.targetPath}` };
      }
      const content = fs.readFileSync(source.absolutePath);
      try {
        assertWorkspaceFileContentPolicy({
          relativePath: target.relativePath,
          contentBuffer: content,
          sizeBytes: source.sizeBytes
        });
      } catch (error) {
        return { ok: false, status: 400, error: error.message };
      }
      fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
      fs.writeFileSync(target.absolutePath, content);
      stripExecutableMode(target.absolutePath);
      const archived = await archiveWorkspacePath(access.workspace, target.relativePath, {
        operationId
      });
      const stat = fs.statSync(target.absolutePath);
      const file = fileMetadataFromStat({
        workspaceId: access.workspace.workspaceId,
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        stat,
        includeHash: true
      });
      if (archived) {
        mutations.push({
          action: "put",
          key: target.relativePath,
          valueRef: archived.rootCid,
          metadata: filePayloadMetadata(file)
        });
        contentRefs.push(...(archived.contentRefs || []));
      }
      appliedActions.push(action);
    }
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    const stateCommit = await commitWorkspaceFileState({
      workspace: access.workspace,
      operationId,
      mutations,
      contentRefs,
      payload: {
        action: "sync.apply",
        targetPath: plan.targetPath,
        mountRef: plan.mountRef,
        deleteExtraneous: plan.deleteExtraneous,
        summary: plan.summary
      }
    });
    const checkpoint = await recordWorkspaceFileCheckpoint({
      workspace: access.workspace,
      operationId,
      stateCommit,
      action: "sync.apply",
      path: plan.targetPath || "/"
    });
    return {
      ...plan,
      dryRun: false,
      stateCommit,
      checkpoint,
      appliedActions,
      summary: {
        ...plan.summary,
        applied: appliedActions.length
      }
    };
  }

  async function decodeWorkspaceSnapshotContent(entry = {}) {
    if (entry.contentCid || entry.cid) {
      if (!merkleState) {
        throw new Error("文件快照引用 CAS contentCid，但 Merkle State 基座不可用。");
      }
      const block = await merkleState.cas.getBlock(String(entry.contentCid || entry.cid));
      if (!block) {
        throw new Error(`文件快照内容块不存在：${entry.contentCid || entry.cid}`);
      }
      return block.bytes;
    }
    return decodeWorkspaceFileContent(entry);
  }

  async function normalizeWorkspaceFileSnapshot(input = {}) {
    const snapshot = asObject(input.snapshot || input.workspaceFileSnapshot || input.fileSnapshot || input);
    const basePath = normalizeWorkspaceRelativePath(snapshot.basePath || snapshot.rootPath || input.basePath || "", { allowEmpty: true });
    const rawFiles = asArray(snapshot.files || snapshot.entries || input.files);
    const localDirectorySnapshots = asArray(snapshot.localDirectorySnapshots || snapshot.mountSnapshots);
    return {
      basePath,
      stateRoot: String(snapshot.stateRoot || snapshot.workspaceRevision || ""),
      stateEventAnchor: asObject(snapshot.stateEventAnchor),
      deleteExtraneous: snapshot.deleteExtraneous === true || input.deleteExtraneous === true,
      localDirectorySnapshots,
      files: await Promise.all(rawFiles.map(async (entry) => {
        const rawRelativePath = normalizeWorkspaceRelativePath(
          entry.path || entry.relativePath || entry.filePath || entry.name || "",
          { allowEmpty: false }
        );
        const relativePath = basePath && rawRelativePath !== basePath && !rawRelativePath.startsWith(`${basePath}/`)
          ? joinWorkspaceRelativePath(basePath, rawRelativePath)
          : rawRelativePath;
        if (path.posix.basename(relativePath).startsWith(".")) {
          throw new Error("不允许恢复以 . 开头的文件。");
        }
        const exists = entry.exists !== false && entry.deleted !== true && entry.tombstone !== true;
        const content = exists ? await decodeWorkspaceSnapshotContent(entry) : Buffer.alloc(0);
        if (exists) {
          assertWorkspaceFileContentPolicy({
            relativePath,
            contentBuffer: content
          });
        }
        const contentSha256 = exists ? sha256Buffer(content) : "";
        const expectedSha256 = normalizeSha256(entry.contentSha256 || entry.sha256 || entry.expectedSha256 || "");
        if (expectedSha256 && expectedSha256 !== contentSha256) {
          throw new Error(`文件快照 hash 不匹配：${relativePath}`);
        }
        return {
          relativePath,
          exists,
          content,
          contentSha256,
          encoding: String(entry.encoding || "base64")
        };
      }))
    };
  }

  async function restoreWorkspaceFiles(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let snapshot;
    try {
      snapshot = await normalizeWorkspaceFileSnapshot(input);
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    const dryRun = input.dryRun === true || input.preview === true;
    let mutationOrigin;
    try {
      mutationOrigin = sandboxMutationOrigin(input, {
        requireApproval: !dryRun
      });
    } catch (error) {
      return { ok: false, status: Number(error?.status || 409), error: error.message, code: error.code };
    }
    const requestedBy = String(input.createdBy || input.actorUserId || input.agentId || "").trim();
    if (
      snapshot.localDirectorySnapshots.length > 0 &&
      (typeof restoreLocalDirectoryPreimage !== "function" || typeof rollbackLocalDirectoryMutation !== "function")
    ) {
      return { ok: false, status: 503, error: "本机目录 checkpoint 恢复接口不可用。" };
    }
    const desiredByPath = new Map(snapshot.files.map((entry) => [entry.relativePath, entry]));
    const existing = await listWorkspaceFiles({
      ...input,
      workspaceId: access.workspace.workspaceId,
      path: snapshot.basePath,
      folderPath: snapshot.basePath,
      recursive: true,
      includeDirectories: false,
      includeFiles: true,
      includeHash: true,
      limit: input.limit || 5000,
    });
    if (!existing.ok) {
      return existing;
    }
    const existingByPath = new Map(existing.files.map((file) => [file.relativePath, file]));
    const sandboxActions = [];
    for (const entry of snapshot.files) {
      const current = existingByPath.get(entry.relativePath);
      if (!entry.exists) {
        sandboxActions.push({
          action: current ? "delete" : "noop",
          scope: "workspace",
          path: entry.relativePath,
          currentSha256: current?.contentSha256 || ""
        });
        continue;
      }
      const action = !current
        ? "create"
        : current.contentSha256 === entry.contentSha256
          ? "noop"
          : "write";
      sandboxActions.push({
        action,
        scope: "workspace",
        path: entry.relativePath,
        expectedSha256: entry.contentSha256,
        currentSha256: current?.contentSha256 || ""
      });
    }
    if (snapshot.deleteExtraneous) {
      for (const current of existing.files) {
        if (!desiredByPath.has(current.relativePath)) {
          sandboxActions.push({
            action: "delete",
            scope: "workspace",
            path: current.relativePath,
            currentSha256: current.contentSha256 || "",
            extraneous: true
          });
        }
      }
    }
    const localPlans = [];
    try {
      for (const localSnapshot of snapshot.localDirectorySnapshots) {
        if (String(localSnapshot.workspaceId || access.workspace.workspaceId) !== access.workspace.workspaceId) {
          return { ok: false, status: 403, error: "本机目录 checkpoint 不属于当前工作空间。" };
        }
        localPlans.push(await restoreLocalDirectoryPreimage({
          workspace: access.workspace,
          snapshot: localSnapshot,
          dryRun: true
        }));
      }
    } catch (error) {
      return {
        ok: false,
        status: Math.max(400, Number(error?.status || 400) || 400),
        error: String(error?.code || "").startsWith("local_directory_")
          ? error.message
          : "本机目录 checkpoint 预览失败。"
      };
    }
    const actions = [
      ...sandboxActions,
      ...localPlans.flatMap((plan) => plan.actions || [])
    ];
    if (dryRun) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        dryRun: true,
        stateCommit: null,
        checkpoint: null,
        basePath: snapshot.basePath,
        deleteExtraneous: snapshot.deleteExtraneous,
        fileCount: snapshot.files.length,
        localDirectorySnapshotCount: snapshot.localDirectorySnapshots.length,
        actions,
        appliedActions: [],
        summary: {
          create: actions.filter((action) => action.action === "create").length,
          write: actions.filter((action) => action.action === "write" || action.action === "replace").length,
          delete: actions.filter((action) => action.action === "delete").length,
          noop: actions.filter((action) => action.action === "noop").length,
          applied: 0
        },
        ...(mutationOrigin ? { mutationOrigin } : {})
      };
    }

    const sandboxApplied = [];
    const sandboxPreimages = new Map();
    const localApplied = [];
    let stateCommit = null;
    const restoreStartState = await merkleState?.stateCommit?.begin?.({ scope: fileStateApi.workspaceStateScope(access.workspace) });
    const restoreStartEvents = await merkleState?.eventLog?.listEvents?.(fileStateApi.workspaceStateScope(access.workspace), { limit: 1 }) || [];
    try {
      const stateRootAllowedOperationIds = asArray(input.stateRootAllowedOperationIds).map(String).filter(Boolean);
      if (snapshot.stateRoot && stateRootAllowedOperationIds.length > 0) {
        await input.leaseGuard?.();
        await merkleState?.stateCommit?.verifyRestoreLineage?.({
          scope: fileStateApi.workspaceStateScope(access.workspace),
          targetRoot: snapshot.stateRoot,
          allowedOperationIds: stateRootAllowedOperationIds,
          anchor: snapshot.stateEventAnchor
        });
        await input.leaseGuard?.();
      }
      for (const localSnapshot of snapshot.localDirectorySnapshots) {
        localApplied.push(await restoreLocalDirectoryPreimage({
          workspace: access.workspace,
          snapshot: localSnapshot,
          dryRun: false
        }));
      }
      for (const action of sandboxActions) {
        await input.leaseGuard?.();
        if (action.action === "noop") {
          await input.leaseGuard?.();
          continue;
        }
        const entry = desiredByPath.get(action.path);
        let resolved;
        try {
          resolved = resolveWorkspacePath(access.workspace, action.path);
        } catch (error) {
          throw error;
        }
        if (!sandboxPreimages.has(action.path)) {
          try {
            const handle = await fsPromises.open(resolved.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
              const stat = await handle.stat();
              if (!stat.isFile()) throw new Error("Workspace restore target is not a regular file.");
              sandboxPreimages.set(action.path, { exists: true, content: await handle.readFile() });
            } finally {
              await handle.close();
            }
          } catch (preimageError) {
            if (preimageError?.code !== "ENOENT") throw preimageError;
            sandboxPreimages.set(action.path, { exists: false, content: null });
          }
        }
        if (action.action === "delete") {
          await fsPromises.rm(resolved.absolutePath, { recursive: true, force: true });
          sandboxApplied.push(action);
          await input.leaseGuard?.();
          continue;
        }
        await fsPromises.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
        await fsPromises.writeFile(resolved.absolutePath, entry.content);
        stripExecutableMode(resolved.absolutePath);
        sandboxApplied.push(action);
        await input.leaseGuard?.();
      }
      const localAppliedActions = localApplied.flatMap((result) => result.appliedActions || []);
      const applied = [...sandboxApplied, ...localAppliedActions];
      if (applied.length > 0) {
        updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      }
      try {
        getRuntimeLogger().info("agent_workspace.files.restore.completed", {
          workspaceId: access.workspace.workspaceId,
          fileCount: snapshot.files.length,
          localDirectorySnapshotCount: snapshot.localDirectorySnapshots.length,
          appliedCount: applied.length,
          dryRun,
          requestedBy
        });
      } catch {
        // Logging must not turn a completed restore into a failed operation.
      }
      const commitMutations = localApplied.flatMap((result) => result.stateMutations || []);
      const commitRefs = localApplied.flatMap((result) => result.contentRefs || []);
      const workspacePreimageFiles = [];
      for (const [relativePath, preimage] of sandboxPreimages) {
        if (!preimage?.exists) {
          workspacePreimageFiles.push({ path: relativePath, exists: false });
          continue;
        }
        if (!merkleState?.cas?.putBlock) {
          const error = new Error("Workspace restore preimage authority is unavailable.");
          error.code = "workspace_restore_preimage_unavailable";
          error.status = 503;
          throw error;
        }
        const block = await merkleState.cas.putBlock(preimage.content, {
          codec: "raw",
          metadata: { workspaceId: access.workspace.workspaceId, relativePath, preimage: true }
        });
        workspacePreimageFiles.push({
          path: relativePath,
          exists: true,
          contentCid: block.cid,
          contentSha256: normalizeSha256(block.payloadHash),
          byteLength: block.byteLength,
          encoding: "base64"
        });
        commitRefs.push(block.cid);
      }
      for (const action of sandboxApplied) {
        if (action.action === "delete") {
          commitMutations.push({
            action: "delete",
            key: action.path
          });
          continue;
        }
        const archived = await archiveWorkspacePath(access.workspace, action.path, {
          operationId: input.operationId || "workspace.checkpoint.restore",
          contentBuffer: desiredByPath.get(action.path)?.content
        });
        await input.leaseGuard?.();
        if (archived) {
          commitMutations.push({
            action: "put",
            key: action.path,
            valueRef: archived.rootCid,
            metadata: archived.metadata
          });
          commitRefs.push(...archived.contentRefs);
        }
      }
      stateCommit = applied.length > 0 || mutationOrigin
        ? await commitWorkspaceFileState({
          workspace: access.workspace,
          operationId: input.operationId || "workspace.checkpoint.restore",
          mutations: commitMutations,
          contentRefs: commitRefs,
          payload: {
            action: "files.restore",
            basePath: snapshot.basePath,
            appliedCount: applied.length,
            localDirectorySnapshotCount: snapshot.localDirectorySnapshots.length,
            reason: input.reason || "",
            ...(mutationOrigin ? { mutationOrigin } : {})
          }
        })
        : null;
      const currentState = snapshot.stateRoot && stateRootAllowedOperationIds.length > 0
        ? await merkleState?.stateCommit?.begin?.({ scope: fileStateApi.workspaceStateScope(access.workspace) })
        : null;
      if (snapshot.stateRoot && stateRootAllowedOperationIds.length > 0 && currentState?.currentRoot !== snapshot.stateRoot && typeof merkleState?.stateCommit?.restoreRoot === "function") {
        await input.leaseGuard?.();
        stateCommit = await merkleState.stateCommit.restoreRoot({
          scope: fileStateApi.workspaceStateScope(access.workspace),
          targetRoot: snapshot.stateRoot,
          expectedCurrentRoot: currentState.currentRoot,
          allowedOperationIds: stateRootAllowedOperationIds,
          anchor: snapshot.stateEventAnchor,
          operationId: `${input.operationId || "workspace.checkpoint.restore"}.state-root`,
          contentRefs: commitRefs,
          payload: {
            action: "files.restore.state-root",
            workspaceId: access.workspace.workspaceId,
            appliedCount: applied.length
          }
        });
        await input.leaseGuard?.();
      }
      if (applied.length > 0 && !stateCommit?.commitId) {
        const error = new Error("checkpoint restore 状态提交不可用。");
        error.code = "local_directory_state_commit_unavailable";
        error.status = 503;
        throw error;
      }
      const restorePreimageSnapshot = workspacePreimageFiles.length > 0 || localApplied.length > 0 || mutationOrigin
        ? {
            schemaVersion: "v0.0.1:workspace:file-restore-snapshot-1",
            workspaceId: access.workspace.workspaceId,
            basePath: "",
            deleteExtraneous: false,
            files: workspacePreimageFiles,
            localDirectorySnapshots: localApplied.map((result) => result.rollbackSnapshot)
          }
        : null;
      const checkpoint = stateCommit
        ? await recordWorkspaceFileCheckpoint({
          workspace: access.workspace,
          operationId: input.operationId || "workspace.checkpoint.restore",
          stateCommit,
          action: "files.restore",
          path: snapshot.basePath,
          preimageSnapshot: restorePreimageSnapshot,
          mutationOrigin
        })
        : null;
      if (stateCommit && localApplied.length > 0 && !checkpoint?.nodeId) {
        const error = new Error("checkpoint restore 节点提交不可用。");
        error.code = "local_directory_checkpoint_unavailable";
        error.status = 503;
        throw error;
      }
      const mutationReceipt = sandboxMutationReceipt({
        mutationOrigin,
        preimage: restorePreimageSnapshot,
        stateCommit,
        checkpoint
      });
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        dryRun: false,
        stateCommit,
        checkpoint,
        basePath: snapshot.basePath,
        deleteExtraneous: snapshot.deleteExtraneous,
        fileCount: snapshot.files.length,
        localDirectorySnapshotCount: snapshot.localDirectorySnapshots.length,
        actions,
        appliedActions: applied,
        ...(mutationReceipt ? { mutationReceipt } : {}),
        summary: {
          create: actions.filter((action) => action.action === "create").length,
          write: actions.filter((action) => action.action === "write" || action.action === "replace").length,
          delete: actions.filter((action) => action.action === "delete").length,
          noop: actions.filter((action) => action.action === "noop").length,
          applied: applied.length
        },
        ...(mutationOrigin ? { mutationOrigin } : {})
      };
    } catch (error) {
      let rollbackFailed = false;
      const compensationMutations = [];
      const compensationRefs = [];
      for (const action of [...sandboxApplied].reverse()) {
        try {
          await input.leaseGuard?.();
          const resolved = resolveWorkspacePath(access.workspace, action.path);
          const preimage = sandboxPreimages.get(action.path);
          if (preimage?.exists) {
            await fsPromises.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
            await fsPromises.writeFile(resolved.absolutePath, preimage.content);
            stripExecutableMode(resolved.absolutePath);
          } else {
            await fsPromises.rm(resolved.absolutePath, { recursive: true, force: true });
          }
          await input.leaseGuard?.();
        } catch {
          rollbackFailed = true;
        }
      }
      for (const result of [...localApplied].reverse()) {
        try {
          const projection = await rollbackLocalDirectoryMutation({
            workspace: access.workspace,
            snapshot: result.rollbackSnapshot
          });
          compensationMutations.push(...(projection.mutations || []));
          compensationRefs.push(...(projection.contentRefs || []));
        } catch {
          rollbackFailed = true;
        }
      }
      if (!rollbackFailed && stateCommit?.commitId && compensationMutations.length > 0) {
        try {
          const compensation = await commitWorkspaceFileState({
            workspace: access.workspace,
            operationId: `${input.operationId || "workspace.checkpoint.restore"}.rollback`,
            mutations: compensationMutations,
            contentRefs: compensationRefs,
            payload: {
              action: "files.restore.rollback",
              failedCommitId: stateCommit.commitId,
              localDirectorySnapshotCount: localApplied.length
            }
          });
          if (!compensation?.commitId) {
            rollbackFailed = true;
          }
        } catch {
          rollbackFailed = true;
        }
      }
      if (!rollbackFailed && restoreStartState?.currentRoot && typeof merkleState?.stateCommit?.restoreRoot === "function") {
        try {
          const current = await merkleState.stateCommit.begin({ scope: fileStateApi.workspaceStateScope(access.workspace) });
          if (current.currentRoot !== restoreStartState.currentRoot) {
            await merkleState.stateCommit.restoreRoot({
              scope: fileStateApi.workspaceStateScope(access.workspace),
              targetRoot: restoreStartState.currentRoot,
              expectedCurrentRoot: current.currentRoot,
              allowedOperationIds: [input.operationId || "workspace.checkpoint.restore"],
              anchor: restoreStartEvents[0] ? { offset: restoreStartEvents[0].offset, eventHash: restoreStartEvents[0].eventHash } : null,
              operationId: `${input.operationId || "workspace.checkpoint.restore"}.compensation`,
              payload: {
                action: "files.restore.compensation",
                ...(stateCommit?.commitId ? { failedCommitId: stateCommit.commitId } : {})
              }
            });
          }
        } catch {
          rollbackFailed = true;
        }
      }
      return {
        ok: false,
        compensated: !rollbackFailed,
        status: rollbackFailed ? 500 : Math.max(400, Number(error?.status || 500) || 500),
        code: rollbackFailed ? "workspace_restore_compensation_failed" : String(error?.code || "workspace_restore_failed"),
        error: rollbackFailed
          ? "本机目录 checkpoint 恢复失败，且无法恢复 apply 前状态。"
          : "本机目录 checkpoint 恢复未完成，已恢复 apply 前状态。"
      };
    }
  }


  return {
    scanDirectoryForWorkspaceSync,
    scanWorkspaceFilesForSync,
    localDirectorySyncPlan,
    applyLocalDirectorySync,
    decodeWorkspaceSnapshotContent,
    normalizeWorkspaceFileSnapshot,
    restoreWorkspaceFiles
  };
}
