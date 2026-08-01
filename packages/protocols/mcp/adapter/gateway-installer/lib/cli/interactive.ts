import { randomBytes } from "node:crypto";

import { stableStringify } from "../../mcp-identity.ts";
import { deleteProcessIdentity, loadProcessIdentity, saveProcessIdentity } from "../process-identity-store.ts";
import { DEFAULT_TOKEN_ENV, packageJson, TARGET_LOCATIONS, msg } from "./constants.ts";
import { mcpTargetHeaders, normalizeBaseUrl, normalizeTarget, option, targetLabel } from "./basic-utils.ts";
import { writeServerConfigProfile } from "./device-config.ts";
import { discoverMeshrixHub, resolveToken } from "./discovery.ts";
import {
  createProcessIdentityClaim,
  processIdentityHeaders,
  sha256Hex
} from "./process-identity-request.ts";
import { fetchJson } from "./http-json-client.ts";
import { resolveGrantRequestFields } from "./grant-request.ts";
import { redactToken } from "./installer-output-safety.ts";
import { canUseInstallTui, installerOptions } from "./installer-options.ts";
import { isGenericRemoteLocation } from "./scan-candidates.ts";

export function statusGlyph(status?: any) : any {
  if (status === "detected") {
    return "ok";
  }
  if (status === "not-detected") {
    return "--";
  }
  return "??";
}

export function selectionGlyph(selected?: any) : any {
  return selected ? "x" : " ";
}

export function renderInstallMenu({ candidates, index, selectedIds, baseUrl, message = "", mode = "install" }: Record<string, any>) : any {
  const action: any = mode === "uninstall" ? "uninstall" : "install";
  const title: any = mode === "uninstall" ? msg("Meshrix MCP uninstall", "Meshrix MCP 卸载") : msg("Meshrix MCP install", "Meshrix MCP 安装");
  const mcpLine: any = baseUrl ? `MCP: ${baseUrl}/mcp` : msg("MCP: no server URL required for local client removal", "MCP: 本地卸载无需服务端 URL");
  const rows: any[] = [
    "\x1b[2J\x1b[H",
    title,
    "",
    mcpLine,
    msg(`Use Up/Down or j/k, Space to toggle, a to toggle detected, Enter to ${action}, q to cancel.`, `使用上下键或 j/k 移动，空格键选择/取消，按 a 全选检测到的客户端，Enter 键确认${action === "uninstall" ? "卸载" : "安装"}，q 键取消。`),
    "",
    ...candidates.map((candidate?: any, candidateIndex?: any) : any => {
      const pointer: any = candidateIndex === index ? ">" : " ";
      const selected: any = selectedIds.has(candidate.id);
      const label: any = `${candidate.label}`.padEnd(28, " ");
      const installed: any = candidate.installed ? msg("[installed] ", "[已安装] ") : "";
      return `${pointer} [${selectionGlyph(selected)}] ${installed}${label} ${candidate.detail || ""}`;
    }),
    "",
    message
  ];
  process.stdout.write(rows.join("\n"));
}
export function renderAutoUpdateMenu({ enabled }: Record<string, any>) : any {
  const rows: any[] = [
    "\x1b[2J\x1b[H",
    msg("Meshrix MCP Auto-Update Preference", "Meshrix MCP 自动推送更新设置"),
    "",
    msg("Do you want to enable automatic push updates?", "您是否希望启用自动推送更新？"),
    msg("If enabled, your local AI agent will automatically download and install updates when the server pushes them.", "如果启用，当服务端推送更新时，您的本地 AI 智能体将自动下载并安装更新。"),
    msg("(This is disabled by default for security).", "（出于安全考虑，此功能默认禁用）。"),
    "",
    enabled
      ? msg("> [x] Enable automatic push updates", "> [x] 启用自动推送更新")
      : msg("  [ ] Enable automatic push updates", "  [ ] 启用自动推送更新"),
    enabled
      ? msg("  [ ] Disable automatic push updates (Recommended)", "  [ ] 禁用自动推送更新 (推荐)")
      : msg("> [x] Disable automatic push updates (Recommended)", "> [x] 禁用自动推送更新 (推荐)"),
    "",
    msg("Use Up/Down to toggle, Enter to confirm.", "使用上下键切换，Enter 键确认。")
  ];
  process.stdout.write(rows.join("\n") + "\n");
}

export async function chooseAutoUpdate() : Promise<any> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  let enabled: any = false;
  return new Promise((resolve?: any, reject?: any) : any => {
    const stdin: any = process.stdin;
    const wasRaw: any = stdin.isRaw;
    const cleanup: any = () : any => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h\n");
    };

    renderAutoUpdateMenu({ enabled });

    const onData: any = (chunk?: any) : any => {
      const key: any = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        reject(new Error("Interactive install cancelled."));
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(enabled);
        return;
      }
      if (key === "\u001b[A" || key === "k" || key === "K" || key === "\u001b[B" || key === "j" || key === "J" || key === " ") {
        enabled = !enabled;
        renderAutoUpdateMenu({ enabled });
      }
    };

    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.write("\x1b[?25l");
  });
}

export async function chooseInstallCandidates({ candidates, baseUrl }: Record<string, any>) : Promise<any> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive install requires a TTY. Pass --target for non-interactive use.");
  }
  let index: any = Math.max(0, candidates.findIndex((candidate?: any) : any => candidate.status === "detected"));
  if (index < 0) {
    index = 0;
  }
  const selectedIds: any = new Set<any>();
  let message: any = msg("Space selects one or more clients. Enter installs selected clients.", "空格键选择一个或多个客户端，Enter 键确认安装。");
  return new Promise((resolve?: any, reject?: any) : any => {
    const stdin: any = process.stdin;
    const wasRaw: any = stdin.isRaw;
    const cleanup: any = () : any => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h\n");
    };
    const onData: any = (chunk?: any) : any => {
      const key: any = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        reject(new Error("Interactive install cancelled."));
        return;
      }
      if (key === "q" || key === "Q" || key === "\u001b") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        const selected: any = candidates.filter((candidate?: any) : any => selectedIds.has(candidate.id));
        if (selected.length === 0) {
          message = msg("No clients selected. Press Space to select at least one client.", "未选中任何客户端，请按空格键至少选择一个。");
          renderInstallMenu({ candidates, index, selectedIds, baseUrl, message });
          return;
        }
        cleanup();
        resolve(selected);
        return;
      }
      if (key === " ") {
        const selected: any = candidates[index];
        if (selectedIds.has(selected.id)) {
          selectedIds.delete(selected.id);
        } else {
          selectedIds.add(selected.id);
        }
        message = selectedIds.size === 1 ? msg("1 client selected.", "已选择 1 个客户端。") : msg(`${selectedIds.size} clients selected.`, `已选择 ${selectedIds.size} 个客户端。`);
      } else if (key === "a" || key === "A") {
        const detected: any = candidates.filter((candidate?: any) : any => candidate.status === "detected");
        const shouldSelect: any = detected.some((candidate?: any) : any => !selectedIds.has(candidate.id));
        for (const candidate of detected) {
          if (shouldSelect) {
            selectedIds.add(candidate.id);
          } else {
            selectedIds.delete(candidate.id);
          }
        }
        message = shouldSelect
          ? msg(`${detected.length} detected clients selected.`, `已选择检测到的 ${detected.length} 个客户端。`)
          : msg("Detected clients cleared.", "已清除选中的检测客户端。");
      }
      if (key === "\u001b[A" || key === "k" || key === "K") {
        index = (index - 1 + candidates.length) % candidates.length;
      } else if (key === "\u001b[B" || key === "j" || key === "J") {
        index = (index + 1) % candidates.length;
      }
      renderInstallMenu({ candidates, index, selectedIds, baseUrl, message });
    };
    process.stdout.write("\x1b[?25l");
    renderInstallMenu({ candidates, index, selectedIds, baseUrl, message });
    stdin.setEncoding("utf8");
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function chooseUninstallCandidates({ candidates, baseUrl }: Record<string, any>) : Promise<any> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive uninstall requires a TTY. Pass --target for non-interactive use.");
  }
  let index: any = Math.max(0, candidates.findIndex((candidate?: any) : any => candidate.status === "detected"));
  if (index < 0) {
    index = 0;
  }
  const selectedIds: any = new Set<any>();
  let message: any = msg("Space selects one or more clients. Enter removes Meshrix MCP from selected clients.", "空格键选择一个或多个客户端，Enter 键确认移除所选客户端的 Meshrix MCP 服务。");
  return new Promise((resolve?: any, reject?: any) : any => {
    const stdin: any = process.stdin;
    const wasRaw: any = stdin.isRaw;
    const cleanup: any = () : any => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h\n");
    };
    const onData: any = (chunk?: any) : any => {
      const key: any = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        reject(new Error("Interactive uninstall cancelled."));
        return;
      }
      if (key === "q" || key === "Q" || key === "\u001b") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        const selected: any = candidates.filter((candidate?: any) : any => selectedIds.has(candidate.id));
        if (selected.length === 0) {
          message = msg("No clients selected. Press Space to select at least one client.", "未选中任何客户端，请按空格键至少选择一个。");
          renderInstallMenu({ candidates, index, selectedIds, baseUrl, message, mode: "uninstall" });
          return;
        }
        cleanup();
        resolve(selected);
        return;
      }
      if (key === " ") {
        const selected: any = candidates[index];
        if (selectedIds.has(selected.id)) {
          selectedIds.delete(selected.id);
        } else {
          selectedIds.add(selected.id);
        }
        message = selectedIds.size === 1 ? msg("1 client selected for removal.", "已选择 1 个客户端用于移除。") : msg(`${selectedIds.size} clients selected for removal.`, `已选择 ${selectedIds.size} 个客户端用于移除。`);
      } else if (key === "a" || key === "A") {
        const detected: any = candidates.filter((candidate?: any) : any => candidate.status === "detected");
        const shouldSelect: any = detected.some((candidate?: any) : any => !selectedIds.has(candidate.id));
        for (const candidate of detected) {
          if (shouldSelect) {
            selectedIds.add(candidate.id);
          } else {
            selectedIds.delete(candidate.id);
          }
        }
        message = shouldSelect
          ? msg(`${detected.length} detected clients selected for removal.`, `已选择检测到的 ${detected.length} 个客户端用于移除。`)
          : msg("Detected clients cleared.", "已清除选中的检测客户端。");
      }
      if (key === "\u001b[A" || key === "k" || key === "K") {
        index = (index - 1 + candidates.length) % candidates.length;
      } else if (key === "\u001b[B" || key === "j" || key === "J") {
        index = (index + 1) % candidates.length;
      }
      renderInstallMenu({ candidates, index, selectedIds, baseUrl, message, mode: "uninstall" });
    };
    process.stdout.write("\x1b[?25l");
    renderInstallMenu({ candidates, index, selectedIds, baseUrl, message, mode: "uninstall" });
    stdin.setEncoding("utf8");
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function promptLine(prompt?: any, { hidden = false }: Record<string, any> = {}) : Promise<any> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive prompt requires a TTY.");
  }
  return new Promise((resolve?: any, reject?: any) : any => {
    const stdin: any = process.stdin;
    const wasRaw: any = stdin.isRaw;
    let value: any = "";
    const cleanup: any = () : any => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData: any = (chunk?: any) : any => {
      const key: any = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        reject(new Error("Interactive install cancelled."));
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(value.trim());
        return;
      }
      if (key === "\u007f") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          if (!hidden) {
            process.stdout.write("\b \b");
          }
        }
        return;
      }
      if (key >= " ") {
        value += key;
        if (!hidden) {
          process.stdout.write(key);
        }
      }
    };
    process.stdout.write(prompt);
    stdin.setEncoding("utf8");
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function resolveInteractiveToken(options?: any) : Promise<any> {
  const token: any = await resolveToken(options, { required: false });
  if (token) {
    return token;
  }
  const tokenEnv: any = String(option(options, "token-env", DEFAULT_TOKEN_ENV));
  const entered: any = await promptLine(`Meshrix MCP token (${tokenEnv}): `, { hidden: true });
  if (!entered) {
    throw new Error(`Missing token. Provide --token-stdin or ${tokenEnv}.`);
  }
  return entered;
}

const LOCAL_MCP_AUTHORIZATION_TIMEOUT_MS: any = 9 * 60 * 1000;
const LOCAL_MCP_AUTHORIZATION_POLL_INTERVAL_MS: any = 1_000;

function boundedPositiveInteger(value?: any, fallback?: any, { min = 1, max = Number.MAX_SAFE_INTEGER }: Record<string, any> = {}) : any {
  const parsed: any = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    return fallback;
  }
  return Math.min(max, parsed);
}

function waitForAuthorizationPoll(delayMs?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, delayMs));
}

function localAuthorizationVerificationCode(claimTokenHash?: any) : any {
  const normalized: any = String(claimTokenHash || "").toUpperCase();
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
}

async function requestApprovedLocalMcpGrant(options?: any, requestPayload?: any) : Promise<any> {
  const settings: any = installerOptions(options);
  const claimToken: any = randomBytes(32).toString("base64url");
  const claimTokenHash: any = sha256Hex(Buffer.from(claimToken, "utf8"));
  const requestResponse: any = await fetchJson(`${settings.baseUrl}/api/mcp/local-grant/requests`, {
    method: "POST",
    timeoutMs: 10000,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...requestPayload,
      claimTokenHash
    })
  });
  if (!requestResponse.ok || !requestResponse.payload?.requestId) {
    const reason: any = requestResponse.payload?.error?.message || requestResponse.payload?.error || `HTTP ${requestResponse.status}`;
    throw new Error(`Failed to create local MCP installation authorization request: ${reason}`);
  }
  const requestId: any = String(requestResponse.payload.requestId);
  const verificationCode: any = localAuthorizationVerificationCode(claimTokenHash);
  if (requestResponse.payload.verificationCode !== verificationCode) {
    throw new Error("MCP installation authorization verification code did not match the submitted request.");
  }
  const timeoutMs: any = boundedPositiveInteger(
    option(options, "authorization-timeout-ms", LOCAL_MCP_AUTHORIZATION_TIMEOUT_MS),
    LOCAL_MCP_AUTHORIZATION_TIMEOUT_MS,
    { min: 1_000, max: LOCAL_MCP_AUTHORIZATION_TIMEOUT_MS }
  );
  const pollIntervalMs: any = boundedPositiveInteger(
    option(options, "authorization-poll-interval-ms", LOCAL_MCP_AUTHORIZATION_POLL_INTERVAL_MS),
    LOCAL_MCP_AUTHORIZATION_POLL_INTERVAL_MS,
    { min: 50, max: 5_000 }
  );
  const deadline: any = Date.now() + timeoutMs;
  process.stderr.write(
    `MCP installation authorization ${requestId} is pending. ` +
    `Approve verification code ${verificationCode} in the authenticated Meshrix console.\n`
  );
  while (Date.now() < deadline) {
    let consumeResponse: any;
    try {
      consumeResponse = await fetchJson(
        `${settings.baseUrl}/api/mcp/local-grant/requests/${encodeURIComponent(requestId)}/consume`,
        {
          method: "POST",
          timeoutMs: 10000,
          headers: {
            "Content-Type": "application/json",
            "x-meshrix-authorization-claim": claimToken
          },
          body: "{}"
        }
      );
    } catch {
      if (Date.now() + pollIntervalMs >= deadline) {
        break;
      }
      await waitForAuthorizationPoll(pollIntervalMs);
      continue;
    }
    if (consumeResponse.status === 202 && consumeResponse.payload?.status === "pending") {
      await waitForAuthorizationPoll(pollIntervalMs);
      continue;
    }
    if (consumeResponse.ok && consumeResponse.status === 201) {
      return consumeResponse.payload;
    }
    const reason: any = consumeResponse.payload?.error?.message || consumeResponse.payload?.error || `HTTP ${consumeResponse.status}`;
    throw new Error(`Local MCP installation authorization failed: ${reason}`);
  }
  throw new Error(`Local MCP installation authorization ${requestId} timed out before approval.`);
}

function issuerIdentityFromDiscovery(discovered?: any) : any {
  const payload: any = discovered?.handshake?.payload || {};
  const identity: any = payload.identity || {};
  const server: any = payload.server || {};
  if (!identity.keyId || !identity.publicKeyJwk || !server.serverId) {
    return null;
  }
  return {
    keyId: String(identity.keyId),
    publicKeyJwk: identity.publicKeyJwk,
    serverId: String(server.serverId)
  };
}

async function assertNoStoredGrantWillBeOverwritten(targets?: any) : Promise<any> {
  for (const target of targets) {
    if (await loadProcessIdentity(target)) {
      throw new Error(
        `A stored MCP credential already exists for ${targetLabel(target)}. ` +
        `Uninstall ${target} with its issuing server before requesting another grant.`
      );
    }
  }
}

function echoRequestedGrantSummary(grantRequest?: any) : any {
  if (!grantRequest?.explicit) {
    return;
  }
  process.stderr.write(`MCP grant request: ${grantRequest.summary}\n`);
}

export async function requestLocalMcpGrant(options?: any, { targets = [], autoUpdate = false }: Record<string, any> = {}) : Promise<any> {
  const settings: any = installerOptions(options);
  const targetList: any[] = [...new Set<any>(targets.map(normalizeTarget).filter(Boolean))];
  if (targetList.length !== 1) {
    throw new Error("Local MCP grants require exactly one target for process identity binding.");
  }
  const target: any = targetList[0];
  const grantRequest: any = resolveGrantRequestFields(options);
  await assertNoStoredGrantWillBeOverwritten(targetList);
  const processIdentityClaim: any = createProcessIdentityClaim(target);
  echoRequestedGrantSummary(grantRequest);
  const responsePayload: any = await requestApprovedLocalMcpGrant(options, {
    targets: targetList,
    label: `Meshrix MCP ${targetList.length ? targetList.map(targetLabel).join(", ") : "local agent"}`,
    connectorVersion: packageJson.version,
    processIdentity: processIdentityClaim.request,
    autoUpdate,
    ...grantRequest.fields
  });
  if (!responsePayload?.token || !responsePayload?.processIdentity?.clientIdentityPackage) {
    throw new Error("Failed to request local Meshrix MCP process identity package.");
  }
  const material: any = localMcpGrantTargetMaterial({
    settings,
    target,
    responsePayload,
    processIdentityClaim,
    issuerIdentity: issuerIdentityFromDiscovery(options.__meshrixDiscovery)
  });
  try {
    return await persistLocalMcpGrantTargetMaterial(material);
  } catch {
    const rollback: any = await rollbackIssuedCredentialMaterials([material]);
    const suffix: any = rollback.ok
      ? " The newly issued grant was revoked."
      : " The newly issued credential could not be persisted or fully rolled back.";
    throw new Error(`Failed to persist the local MCP credential.${suffix}`);
  }
}

function localMcpGrantTargetMaterial({
  settings,
  target,
  responsePayload,
  processIdentityClaim,
  issuerIdentity = null
}: Record<string, any>) : any {
  const grantToken: any = String(responsePayload.token || "").trim();
  const identityRecord: Record<string, any> = {
    schemaVersion: "v0.0.1:process-identity:mcp-file-1",
    target,
    baseUrl: settings.baseUrl,
    savedAt: new Date().toISOString(),
    grantToken,
    grantId: String(responsePayload.grant?.id || ""),
    tokenPrefix: String(responsePayload.tokenPrefix || responsePayload.grant?.tokenPrefix || ""),
    issuerIdentity,
    privateKeyPem: processIdentityClaim.privateKeyPem,
    clientIdentityPackage: responsePayload.processIdentity.clientIdentityPackage,
    serverIdentity: responsePayload.processIdentity.serverIdentity || null
  };
  return {
    target,
    identityRecord,
    result: {
      token: grantToken,
      source: "device-authorization",
      issuedNow: true,
      grant: responsePayload.grant || null,
      tokenPrefix: responsePayload.tokenPrefix || responsePayload.grant?.tokenPrefix || "",
      toolsets: responsePayload.toolsets || [],
      scopes: responsePayload.scopes || []
    }
  };
}

async function persistLocalMcpGrantTargetMaterial(material?: any) : Promise<any> {
  const identityStorage: any = await saveProcessIdentity(material.target, material.identityRecord);
  return {
    ...material.result,
    processIdentityPath: identityStorage.filePath || "",
    processIdentityRef: identityStorage.reference || "",
    processIdentityStorageBackend: identityStorage.storageBackend || ""
  };
}

async function saveLocalMcpGrantTargetIdentity(input?: any) : Promise<any> {
  return persistLocalMcpGrantTargetMaterial(localMcpGrantTargetMaterial(input));
}

export async function requestLocalMcpGrantBatch(options?: any, { targets = [], autoUpdate = false }: Record<string, any> = {}) : Promise<any> {
  const settings: any = installerOptions(options);
  const targetList: any[] = [...new Set<any>(targets.map(normalizeTarget).filter(Boolean))];
  if (targetList.length === 0) {
    throw new Error("Local MCP grants require at least one target.");
  }
  const grantRequest: any = resolveGrantRequestFields(options);
  await assertNoStoredGrantWillBeOverwritten(targetList);
  if (targetList.length === 1) {
    const grant: any = await requestLocalMcpGrant(options, { targets: targetList, autoUpdate });
    return {
      token: grant.token,
      source: "device-authorization",
      tokenPrefix: grant.tokenPrefix,
      perTarget: true,
      grantsByTarget: {
        [targetList[0]]: grant
      },
      authorizationBatch: {
        singleAuthorizationRequest: true,
        perTargetGrantIsolation: true,
        targetCount: 1
      }
    };
  }
  const claimsByTarget: any = Object.fromEntries(targetList.map((target?: any) : any => [target, createProcessIdentityClaim(target)]));
  const processIdentities: any = Object.fromEntries(
    (Object.entries(claimsByTarget) as [string, any][]).map(([target, claim]: any[]) : any => [target, claim.request])
  );
  echoRequestedGrantSummary(grantRequest);
  const responsePayload: any = await requestApprovedLocalMcpGrant(options, {
    targets: targetList,
    label: `Meshrix MCP ${targetList.map(targetLabel).join(", ")}`,
    connectorVersion: packageJson.version,
    processIdentities,
    autoUpdate,
    ...grantRequest.fields
  });
  if (responsePayload?.ok === false || !responsePayload?.targetGrants) {
    throw new Error("Failed to request batched local Meshrix MCP process identity packages.");
  }
  const issuerIdentity: any = issuerIdentityFromDiscovery(options.__meshrixDiscovery);
  const materials: any[] = [];
  for (const target of targetList) {
    const targetPayload: any = responsePayload.targetGrants[target];
    if (!targetPayload?.token || !targetPayload?.processIdentity?.clientIdentityPackage) {
      const rollbackMaterials: any = materials.concat(
        targetList
          .filter((candidate?: any) : any => !materials.some((material?: any) : any => material.target === candidate))
          .map((candidate?: any) : any => {
            const candidatePayload: any = responsePayload.targetGrants[candidate];
            return candidatePayload?.token && candidatePayload?.processIdentity?.clientIdentityPackage
              ? localMcpGrantTargetMaterial({
                  settings,
                  target: candidate,
                  responsePayload: candidatePayload,
                  processIdentityClaim: claimsByTarget[candidate],
                  issuerIdentity
                })
              : null;
          })
          .filter(Boolean)
      );
      await rollbackIssuedCredentialMaterials(rollbackMaterials);
      throw new Error(`Failed to request local Meshrix MCP process identity package for ${targetLabel(target)}.`);
    }
    materials.push(localMcpGrantTargetMaterial({
      settings,
      target,
      responsePayload: targetPayload,
      processIdentityClaim: claimsByTarget[target],
      issuerIdentity
    }));
  }
  const grantsByTarget: Record<string, any> = {};
  try {
    for (const material of materials) {
      grantsByTarget[material.target] = {
        ...(await persistLocalMcpGrantTargetMaterial(material)),
        source: "device-authorization"
      };
    }
  } catch {
    const rollback: any = await rollbackIssuedCredentialMaterials(materials);
    const suffix: any = rollback.ok
      ? " The newly issued grants were revoked."
      : " At least one newly issued credential was retained for recovery because rollback was incomplete.";
    throw new Error(`Failed to persist the batched local MCP credentials.${suffix}`);
  }
  return {
    token: "",
    source: "device-authorization",
    tokenPrefix: "batch",
    perTarget: true,
    grantsByTarget,
    authorizationBatch: responsePayload.authorizationBatch || {
      singleAuthorizationRequest: true,
      perTargetGrantIsolation: true,
      targetCount: targetList.length
    }
  };
}

function storedIssuerBaseUrl(identity?: any) : any {
  try {
    return normalizeBaseUrl(String(identity?.baseUrl || ""));
  } catch {
    return "";
  }
}

async function verifyStoredIssuer(identity?: any, verifiedIssuers?: any) : Promise<any> {
  const baseUrl: any = storedIssuerBaseUrl(identity);
  const expected: any = identity?.issuerIdentity || {};
  if (!baseUrl || !expected.keyId || !expected.publicKeyJwk || !expected.serverId) {
    throw new Error("The stored MCP credential has no verified issuer binding.");
  }
  let discovered: any = verifiedIssuers.get(baseUrl);
  if (!discovered) {
    discovered = await discoverMeshrixHub({ url: baseUrl });
    if (!discovered.ok) {
      throw new Error("The stored MCP credential issuer could not be verified.");
    }
    verifiedIssuers.set(baseUrl, discovered);
  }
  const actualIdentity: any = discovered.handshake?.payload?.identity || {};
  const actualServer: any = discovered.handshake?.payload?.server || {};
  if (
    String(actualIdentity.keyId || "") !== String(expected.keyId) ||
    stableStringify(actualIdentity.publicKeyJwk || {}) !== stableStringify(expected.publicKeyJwk) ||
    String(actualServer.serverId || "") !== String(expected.serverId)
  ) {
    throw new Error("The stored MCP credential issuer identity did not match the verified server.");
  }
  return baseUrl;
}

async function notifyCredentialUninstall({
  target,
  identity,
  token,
  expectedGrantId = "",
  verifiedIssuers
}: Record<string, any>) : Promise<any> {
  if (!identity?.privateKeyPem || !identity?.clientIdentityPackage) {
    throw new Error(`No stored MCP process identity is available for ${targetLabel(target)}.`);
  }
  if (!token) {
    throw new Error(`No stored MCP grant credential is available for ${targetLabel(target)}.`);
  }
  if (expectedGrantId && String(identity.grantId || "") !== String(expectedGrantId)) {
    throw new Error(`The stored MCP grant changed before ${targetLabel(target)} rollback.`);
  }
  const issuerBaseUrl: any = await verifyStoredIssuer(identity, verifiedIssuers);
  const requestUrl: any = `${issuerBaseUrl}/api/mcp/local-uninstall`;
  const body: any = JSON.stringify({
    targets: [target],
    connectorVersion: packageJson.version
  });
  const response: any = await fetchJson(requestUrl, {
    method: "POST",
    timeoutMs: 10000,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...mcpTargetHeaders(target),
      ...processIdentityHeaders({
        method: "POST",
        url: new URL(requestUrl),
        body,
        identity
      })
    },
    body
  });
  if (!response.ok || response.payload?.ok === false) {
    throw new Error(`Failed to update the Meshrix MCP device list after uninstall (HTTP ${response.status}).`);
  }
  return {
    ok: true,
    serverDeviceRemoved: true,
    status: response.status
  };
}

async function rollbackIssuedCredentialMaterials(materials?: any) : Promise<any> {
  const verifiedIssuers: any = new Map<any, any>();
  const perTarget: Record<string, any> = {};
  for (const material of materials) {
    const target: any = material.target;
    const grantId: any = String(material.result?.grant?.id || material.identityRecord?.grantId || "");
    try {
      await notifyCredentialUninstall({
        target,
        identity: material.identityRecord,
        token: String(material.result?.token || ""),
        expectedGrantId: grantId,
        verifiedIssuers
      });
      const finalized: any = await finalizeRevokedLocalMcpCredential(target, grantId);
      perTarget[target] = {
        ...finalized,
        serverGrantRevoked: true
      };
    } catch {
      let retainedForRecovery: any = false;
      try {
        const existing: any = await loadProcessIdentity(target);
        if (existing && String(existing.grantId || "") !== grantId) {
          throw new Error("stored credential changed");
        }
        if (!existing) {
          await persistLocalMcpGrantTargetMaterial(material);
        }
        retainedForRecovery = true;
      } catch {
        retainedForRecovery = false;
      }
      perTarget[target] = {
        ok: false,
        serverGrantRevoked: false,
        localCredentialRemoved: false,
        credentialRetainedForRecovery: retainedForRecovery
      };
    }
  }
  return {
    ok: (Object.values(perTarget) as any[]).every((result?: any) : any => result.ok === true),
    perTarget
  };
}

export async function notifyLocalMcpUninstall(options?: any, { targets = [], expectedGrantIds = {} }: Record<string, any> = {}) : Promise<any> {
  const targetList: any[] = [...new Set<any>(targets.map(normalizeTarget).filter(Boolean))];
  if (targetList.length === 0) {
    return { ok: true, skipped: true, targets: [], perTarget: {} };
  }
  const providedToken: any = targetList.length === 1
    ? await resolveToken(options, { required: false })
    : "";
  const perTarget: Record<string, any> = {};
  const verifiedIssuers: any = new Map<any, any>();
  for (const target of targetList) {
    try {
      const identity: any = await loadProcessIdentity(target);
      const expectedGrantId: any = String(expectedGrantIds[target] || "");
      if (identity?.grantRevokedAt) {
        if (expectedGrantId && String(identity.grantId || "") !== expectedGrantId) {
          throw new Error(`The stored MCP grant changed before ${targetLabel(target)} rollback.`);
        }
        perTarget[target] = {
          ok: true,
          serverDeviceRemoved: true,
          alreadyRevoked: true
        };
        continue;
      }
      const token: any = String(identity?.grantToken || "").trim() || providedToken;
      perTarget[target] = await notifyCredentialUninstall({
        target,
        identity,
        token,
        expectedGrantId,
        verifiedIssuers
      });
    } catch (error: any) {
      const detail: any = String(error?.message || "");
      const safeDetail: any = /^(?:No stored MCP|The stored MCP|Failed to update the Meshrix MCP device list)/u.test(detail)
        ? detail
        : `Failed to update the Meshrix MCP device list for ${targetLabel(target)}.`;
      perTarget[target] = {
        ok: false,
        serverDeviceRemoved: false,
        error: safeDetail
      };
    }
  }
  return {
    ok: (Object.values(perTarget) as any[]).every((result?: any) : any => result.ok === true),
    targets: targetList,
    perTarget
  };
}

export async function finalizeRevokedLocalMcpCredential(target?: any, expectedGrantId: any = "") : Promise<any> {
  const identity: any = await loadProcessIdentity(target);
  if (!identity) {
    return {
      ok: true,
      localCredentialRemoved: true,
      credentialRetainedForRecovery: false
    };
  }
  if (expectedGrantId && String(identity.grantId || "") !== String(expectedGrantId)) {
    return {
      ok: false,
      localCredentialRemoved: false,
      credentialRetainedForRecovery: true,
      error: "The stored MCP grant changed before local credential cleanup."
    };
  }
  let revocationMarked: any = false;
  try {
    await saveProcessIdentity(target, {
      ...identity,
      filePath: undefined,
      credentialRef: undefined,
      storageBackend: undefined,
      grantRevokedAt: new Date().toISOString()
    });
    revocationMarked = true;
  } catch {
    // Confirmed deletion below remains authoritative when it succeeds.
  }
  try {
    await deleteProcessIdentity(target);
    return {
      ok: true,
      localCredentialRemoved: true,
      credentialRetainedForRecovery: false,
      revocationMarked
    };
  } catch {
    return {
      ok: false,
      localCredentialRemoved: false,
      credentialRetainedForRecovery: true,
      revocationMarked,
      error: "The revoked MCP credential could not be removed from local secure storage."
    };
  }
}

function canonicalInstallLocation(settings?: any) : any {
  const location: any = String(settings.remoteKind || settings.executionLocation || "local").trim().toLowerCase();
  if (!location || location === "local") {
    return "local";
  }
  if (location === "orb" || location === "orbstack") {
    return "orbstack";
  }
  if (isGenericRemoteLocation(location)) {
    return "remote-linux";
  }
  return location;
}

export function assertProcessIdentityInstallLocation(options?: any, targets: any = []) : any {
  const settings: any = installerOptions(options);
  const location: any = canonicalInstallLocation(settings);
  for (const target of [...new Set<any>(targets.map(normalizeTarget).filter(Boolean))]) {
    const supportedLocations: any = TARGET_LOCATIONS[target] || [];
    if (!supportedLocations.includes(location)) {
      throw new Error(
        `${targetLabel(target)} installation at ${location} is not supported by this release. ` +
        "Use a local connector-managed client so every bearer credential is accompanied by signed process identity; device authorization was not started."
      );
    }
  }
}

function sameIssuerIdentity(left?: any, right?: any) : any {
  return Boolean(
    left?.keyId &&
    right?.keyId &&
    String(left.keyId) === String(right.keyId) &&
    String(left.serverId || "") === String(right.serverId || "") &&
    stableStringify(left.publicKeyJwk || {}) === stableStringify(right.publicKeyJwk || {})
  );
}

async function storedGrantForInstall(options?: any, settings?: any, target?: any) : Promise<any> {
  const identity: any = await loadProcessIdentity(target);
  if (!identity) {
    return null;
  }
  const token: any = String(identity.grantToken || "").trim();
  const grantId: any = String(identity.grantId || "").trim();
  const issuerBaseUrl: any = storedIssuerBaseUrl(identity);
  const currentIssuer: any = issuerIdentityFromDiscovery(options.__meshrixDiscovery);
  if (
    !token ||
    !grantId ||
    identity.grantRevokedAt ||
    !issuerBaseUrl ||
    issuerBaseUrl !== settings.baseUrl ||
    !sameIssuerIdentity(identity.issuerIdentity, currentIssuer)
  ) {
    throw new Error(
      `The stored MCP credential for ${targetLabel(target)} cannot be reused for this server. ` +
      `Uninstall ${target} with its issuing server before requesting another grant.`
    );
  }
  return {
    token,
    source: "credential-store",
    issuedNow: false,
    grant: { id: grantId, tokenPrefix: String(identity.tokenPrefix || "") },
    tokenPrefix: String(identity.tokenPrefix || "")
  };
}

export async function resolveInstallToken(options?: any, { targets = [], autoUpdate = false }: Record<string, any> = {}) : Promise<any> {
  assertProcessIdentityInstallLocation(options, targets);
  const explicit: any = await resolveToken(options, { required: false });
  if (explicit) {
    return {
      token: explicit,
      source: "provided",
      tokenPrefix: redactToken(explicit)
    };
  }
  if (options["no-auto-token"]) {
    const tokenEnv: any = String(option(options, "token-env", DEFAULT_TOKEN_ENV));
    throw new Error(`Missing token. Provide --token-stdin or ${tokenEnv}.`);
  }
  const targetList: any[] = [...new Set<any>(targets.map(normalizeTarget).filter(Boolean))];
  if (targetList.length === 0) {
    throw new Error("Local MCP installation requires at least one target.");
  }
  const settings: any = installerOptions(options);
  const existingByTarget: Record<string, any> = {};
  const missingTargets: any[] = [];
  for (const target of targetList) {
    const existing: any = await storedGrantForInstall(options, settings, target);
    if (existing) {
      existingByTarget[target] = existing;
    } else {
      missingTargets.push(target);
    }
  }
  if (targetList.length === 1) {
    return existingByTarget[targetList[0]] || requestLocalMcpGrant(options, {
      targets: targetList,
      autoUpdate
    });
  }
  const issued: any = missingTargets.length > 0
    ? await requestLocalMcpGrantBatch(options, { targets: missingTargets, autoUpdate })
    : { grantsByTarget: {} };
  const grantsByTarget: Record<string, any> = {
    ...existingByTarget,
    ...(issued.grantsByTarget || {})
  };
  return {
    token: "",
    source: missingTargets.length === 0
      ? "credential-store"
      : Object.keys(existingByTarget).length === 0
        ? "device-authorization"
        : "credential-store-and-device-authorization",
    tokenPrefix: "batch",
    perTarget: true,
    grantsByTarget,
    authorizationBatch: issued.authorizationBatch || {
      singleAuthorizationRequest: false,
      perTargetGrantIsolation: true,
      targetCount: targetList.length
    },
    autoUpdate
  };
}

export async function resolveHubForInstall(options?: any) : Promise<any> {
  const discovered: any = await discoverMeshrixHub(options);
  if (discovered.ok) {
    return {
      ...options,
      "resolved-url": discovered.baseUrl,
      __meshrixDiscovery: discovered
    };
  }
  if (!canUseInstallTui(options)) {
    throw new Error(`${discovered.reason} Run meshrix-mcp server-config --set --url <meshrix-url>, or rerun install in a TTY and choose manual configuration.`);
  }
  console.log("No signed Meshrix MCP service was discovered on this device.");
  console.log("The installer will not write any agent client config until a server identity signature is verified.");
  console.log("");
  const answer: any = await promptLine("Choose: [c]onfigure server URL now, [s]kip, manually configure later [s]: ");
  if (!answer || answer.toLowerCase().startsWith("s")) {
    return {
      ...options,
      __meshrixSkippedDiscovery: {
        ok: false,
        skipped: true,
        attempts: discovered.attempts,
        reason: "Skipped. Manually configure later with meshrix-mcp server-config --set --url <meshrix-url>."
      }
    };
  }
  if (!answer.toLowerCase().startsWith("c")) {
    return resolveHubForInstall(options);
  }
  const url: any = await promptLine("Meshrix server URL: ");
  const manual: any = await discoverMeshrixHub({ ...options, url });
  if (!manual.ok) {
    throw new Error(`Failed to verify ${url}: ${manual.reason}`);
  }
  await writeServerConfigProfile({
    options: { ...options, url },
    name: String(option(options, "name", "manual")).trim() || "manual",
    discovered: manual,
    publishEnv: !options["no-env"]
  });
  return {
    ...options,
    "resolved-url": manual.baseUrl,
    __meshrixDiscovery: manual
  };
}

export function remoteContextFromSettings(settings?: any) : any {
  const kind: any = settings.remoteKind || settings.executionLocation;
  if (!isGenericRemoteLocation(kind)) {
    return null;
  }
  const remoteBins: Record<string, any> = {
    docker: settings.dockerBin,
    podman: settings.podmanBin,
    nerdctl: settings.nerdctlBin,
    wsl: settings.wslBin,
    lima: settings.limaBin,
    colima: settings.colimaBin,
    multipass: settings.multipassBin,
    lxc: settings.lxcBin,
    incus: settings.incusBin,
    vagrant: settings.vagrantBin,
    parallels: settings.parallelsBin
  };
  const bin: any = settings.remoteBin
    || remoteBins[kind]
    || "";
  if (!settings.remoteId || !bin) {
    throw new Error(`${kind} install requires a discovered remote context.`);
  }
  return {
    kind,
    id: settings.remoteId,
    name: settings.remoteName || settings.remoteId,
    bin
  };
}
