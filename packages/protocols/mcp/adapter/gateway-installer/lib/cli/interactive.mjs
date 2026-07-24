import { randomBytes } from "node:crypto";

import { stableStringify } from "../../mcp-identity.mjs";
import { deleteProcessIdentity, loadProcessIdentity, saveProcessIdentity } from "../process-identity-store.mjs";
import { DEFAULT_TOKEN_ENV, packageJson, TARGET_LOCATIONS, msg } from "./constants.mjs";
import { mcpTargetHeaders, normalizeBaseUrl, normalizeTarget, option, targetLabel } from "./basic-utils.mjs";
import { writeServerConfigProfile } from "./device-config.mjs";
import { discoverLicoHub, resolveToken } from "./discovery.mjs";
import {
  createProcessIdentityClaim,
  processIdentityHeaders,
  sha256Hex
} from "./process-identity-request.mjs";
import { fetchJson } from "./http-json-client.mjs";
import { redactToken } from "./installer-output-safety.mjs";
import { canUseInstallTui, installerOptions } from "./installer-options.mjs";
import { isGenericRemoteLocation } from "./scan-candidates.mjs";

export function statusGlyph(status) {
  if (status === "detected") {
    return "ok";
  }
  if (status === "not-detected") {
    return "--";
  }
  return "??";
}

export function selectionGlyph(selected) {
  return selected ? "x" : " ";
}

export function renderInstallMenu({ candidates, index, selectedIds, baseUrl, message = "", mode = "install" }) {
  const action = mode === "uninstall" ? "uninstall" : "install";
  const title = mode === "uninstall" ? msg("Meshrix MCP uninstall", "Meshrix MCP 卸载") : msg("Meshrix MCP install", "Meshrix MCP 安装");
  const mcpLine = baseUrl ? `MCP: ${baseUrl}/mcp` : msg("MCP: no server URL required for local client removal", "MCP: 本地卸载无需服务端 URL");
  const rows = [
    "\x1b[2J\x1b[H",
    title,
    "",
    mcpLine,
    msg(`Use Up/Down or j/k, Space to toggle, a to toggle detected, Enter to ${action}, q to cancel.`, `使用上下键或 j/k 移动，空格键选择/取消，按 a 全选检测到的客户端，Enter 键确认${action === "uninstall" ? "卸载" : "安装"}，q 键取消。`),
    "",
    ...candidates.map((candidate, candidateIndex) => {
      const pointer = candidateIndex === index ? ">" : " ";
      const selected = selectedIds.has(candidate.id);
      const label = `${candidate.label}`.padEnd(28, " ");
      const installed = candidate.installed ? msg("[installed] ", "[已安装] ") : "";
      return `${pointer} [${selectionGlyph(selected)}] ${installed}${label} ${candidate.detail || ""}`;
    }),
    "",
    message
  ];
  process.stdout.write(rows.join("\n"));
}
export function renderAutoUpdateMenu({ enabled }) {
  const rows = [
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

export async function chooseAutoUpdate() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  let enabled = false;
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h\n");
    };

    renderAutoUpdateMenu({ enabled });

    const onData = (chunk) => {
      const key = chunk.toString("utf8");
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

export async function chooseInstallCandidates({ candidates, baseUrl }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive install requires a TTY. Pass --target for non-interactive use.");
  }
  let index = Math.max(0, candidates.findIndex((candidate) => candidate.status === "detected"));
  if (index < 0) {
    index = 0;
  }
  const selectedIds = new Set();
  let message = msg("Space selects one or more clients. Enter installs selected clients.", "空格键选择一个或多个客户端，Enter 键确认安装。");
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h\n");
    };
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
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
        const selected = candidates.filter((candidate) => selectedIds.has(candidate.id));
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
        const selected = candidates[index];
        if (selectedIds.has(selected.id)) {
          selectedIds.delete(selected.id);
        } else {
          selectedIds.add(selected.id);
        }
        message = selectedIds.size === 1 ? msg("1 client selected.", "已选择 1 个客户端。") : msg(`${selectedIds.size} clients selected.`, `已选择 ${selectedIds.size} 个客户端。`);
      } else if (key === "a" || key === "A") {
        const detected = candidates.filter((candidate) => candidate.status === "detected");
        const shouldSelect = detected.some((candidate) => !selectedIds.has(candidate.id));
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

export async function chooseUninstallCandidates({ candidates, baseUrl }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive uninstall requires a TTY. Pass --target for non-interactive use.");
  }
  let index = Math.max(0, candidates.findIndex((candidate) => candidate.status === "detected"));
  if (index < 0) {
    index = 0;
  }
  const selectedIds = new Set();
  let message = msg("Space selects one or more clients. Enter removes Meshrix MCP from selected clients.", "空格键选择一个或多个客户端，Enter 键确认移除所选客户端的 Meshrix MCP 服务。");
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h\n");
    };
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
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
        const selected = candidates.filter((candidate) => selectedIds.has(candidate.id));
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
        const selected = candidates[index];
        if (selectedIds.has(selected.id)) {
          selectedIds.delete(selected.id);
        } else {
          selectedIds.add(selected.id);
        }
        message = selectedIds.size === 1 ? msg("1 client selected for removal.", "已选择 1 个客户端用于移除。") : msg(`${selectedIds.size} clients selected for removal.`, `已选择 ${selectedIds.size} 个客户端用于移除。`);
      } else if (key === "a" || key === "A") {
        const detected = candidates.filter((candidate) => candidate.status === "detected");
        const shouldSelect = detected.some((candidate) => !selectedIds.has(candidate.id));
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

export async function promptLine(prompt, { hidden = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive prompt requires a TTY.");
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
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

export async function resolveInteractiveToken(options) {
  const token = await resolveToken(options, { required: false });
  if (token) {
    return token;
  }
  const tokenEnv = String(option(options, "token-env", DEFAULT_TOKEN_ENV));
  const entered = await promptLine(`Meshrix MCP token (${tokenEnv}): `, { hidden: true });
  if (!entered) {
    throw new Error(`Missing token. Provide --token-stdin or ${tokenEnv}.`);
  }
  return entered;
}

const LOCAL_MCP_AUTHORIZATION_TIMEOUT_MS = 9 * 60 * 1000;
const LOCAL_MCP_AUTHORIZATION_POLL_INTERVAL_MS = 1_000;

function boundedPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    return fallback;
  }
  return Math.min(max, parsed);
}

function waitForAuthorizationPoll(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function localAuthorizationVerificationCode(claimTokenHash) {
  const normalized = String(claimTokenHash || "").toUpperCase();
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
}

async function requestApprovedLocalMcpGrant(options, requestPayload) {
  const settings = installerOptions(options);
  const claimToken = randomBytes(32).toString("base64url");
  const claimTokenHash = sha256Hex(Buffer.from(claimToken, "utf8"));
  const requestResponse = await fetchJson(`${settings.baseUrl}/api/mcp/local-grant/requests`, {
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
    const reason = requestResponse.payload?.error?.message || requestResponse.payload?.error || `HTTP ${requestResponse.status}`;
    throw new Error(`Failed to create local MCP installation authorization request: ${reason}`);
  }
  const requestId = String(requestResponse.payload.requestId);
  const verificationCode = localAuthorizationVerificationCode(claimTokenHash);
  if (requestResponse.payload.verificationCode !== verificationCode) {
    throw new Error("MCP installation authorization verification code did not match the submitted request.");
  }
  const timeoutMs = boundedPositiveInteger(
    option(options, "authorization-timeout-ms", LOCAL_MCP_AUTHORIZATION_TIMEOUT_MS),
    LOCAL_MCP_AUTHORIZATION_TIMEOUT_MS,
    { min: 1_000, max: LOCAL_MCP_AUTHORIZATION_TIMEOUT_MS }
  );
  const pollIntervalMs = boundedPositiveInteger(
    option(options, "authorization-poll-interval-ms", LOCAL_MCP_AUTHORIZATION_POLL_INTERVAL_MS),
    LOCAL_MCP_AUTHORIZATION_POLL_INTERVAL_MS,
    { min: 50, max: 5_000 }
  );
  const deadline = Date.now() + timeoutMs;
  process.stderr.write(
    `MCP installation authorization ${requestId} is pending. ` +
    `Approve verification code ${verificationCode} in the authenticated Meshrix console.\n`
  );
  while (Date.now() < deadline) {
    let consumeResponse;
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
    const reason = consumeResponse.payload?.error?.message || consumeResponse.payload?.error || `HTTP ${consumeResponse.status}`;
    throw new Error(`Local MCP installation authorization failed: ${reason}`);
  }
  throw new Error(`Local MCP installation authorization ${requestId} timed out before approval.`);
}

function issuerIdentityFromDiscovery(discovered) {
  const payload = discovered?.handshake?.payload || {};
  const identity = payload.identity || {};
  const server = payload.server || {};
  if (!identity.keyId || !identity.publicKeyJwk || !server.serverId) {
    return null;
  }
  return {
    keyId: String(identity.keyId),
    publicKeyJwk: identity.publicKeyJwk,
    serverId: String(server.serverId)
  };
}

async function assertNoStoredGrantWillBeOverwritten(targets) {
  for (const target of targets) {
    if (await loadProcessIdentity(target)) {
      throw new Error(
        `A stored MCP credential already exists for ${targetLabel(target)}. ` +
        `Uninstall ${target} with its issuing server before requesting another grant.`
      );
    }
  }
}

export async function requestLocalMcpGrant(options, { targets = [], autoUpdate = false } = {}) {
  const settings = installerOptions(options);
  const targetList = [...new Set(targets.map(normalizeTarget).filter(Boolean))];
  if (targetList.length !== 1) {
    throw new Error("Local MCP grants require exactly one target for process identity binding.");
  }
  const target = targetList[0];
  await assertNoStoredGrantWillBeOverwritten(targetList);
  const processIdentityClaim = createProcessIdentityClaim(target);
  const responsePayload = await requestApprovedLocalMcpGrant(options, {
    targets: targetList,
    label: `Meshrix MCP ${targetList.length ? targetList.map(targetLabel).join(", ") : "local agent"}`,
    connectorVersion: packageJson.version,
    processIdentity: processIdentityClaim.request,
    autoUpdate
  });
  if (!responsePayload?.token || !responsePayload?.processIdentity?.clientIdentityPackage) {
    throw new Error("Failed to request local Meshrix MCP process identity package.");
  }
  const material = localMcpGrantTargetMaterial({
    settings,
    target,
    responsePayload,
    processIdentityClaim,
    issuerIdentity: issuerIdentityFromDiscovery(options.__licoDiscovery)
  });
  try {
    return await persistLocalMcpGrantTargetMaterial(material);
  } catch {
    const rollback = await rollbackIssuedCredentialMaterials([material]);
    const suffix = rollback.ok
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
}) {
  const grantToken = String(responsePayload.token || "").trim();
  const identityRecord = {
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

async function persistLocalMcpGrantTargetMaterial(material) {
  const identityStorage = await saveProcessIdentity(material.target, material.identityRecord);
  return {
    ...material.result,
    processIdentityPath: identityStorage.filePath || "",
    processIdentityRef: identityStorage.reference || "",
    processIdentityStorageBackend: identityStorage.storageBackend || ""
  };
}

async function saveLocalMcpGrantTargetIdentity(input) {
  return persistLocalMcpGrantTargetMaterial(localMcpGrantTargetMaterial(input));
}

export async function requestLocalMcpGrantBatch(options, { targets = [], autoUpdate = false } = {}) {
  const settings = installerOptions(options);
  const targetList = [...new Set(targets.map(normalizeTarget).filter(Boolean))];
  if (targetList.length === 0) {
    throw new Error("Local MCP grants require at least one target.");
  }
  await assertNoStoredGrantWillBeOverwritten(targetList);
  if (targetList.length === 1) {
    const grant = await requestLocalMcpGrant(options, { targets: targetList, autoUpdate });
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
  const claimsByTarget = Object.fromEntries(targetList.map((target) => [target, createProcessIdentityClaim(target)]));
  const processIdentities = Object.fromEntries(
    Object.entries(claimsByTarget).map(([target, claim]) => [target, claim.request])
  );
  const responsePayload = await requestApprovedLocalMcpGrant(options, {
    targets: targetList,
    label: `Meshrix MCP ${targetList.map(targetLabel).join(", ")}`,
    connectorVersion: packageJson.version,
    processIdentities,
    autoUpdate
  });
  if (responsePayload?.ok === false || !responsePayload?.targetGrants) {
    throw new Error("Failed to request batched local Meshrix MCP process identity packages.");
  }
  const issuerIdentity = issuerIdentityFromDiscovery(options.__licoDiscovery);
  const materials = [];
  for (const target of targetList) {
    const targetPayload = responsePayload.targetGrants[target];
    if (!targetPayload?.token || !targetPayload?.processIdentity?.clientIdentityPackage) {
      const rollbackMaterials = materials.concat(
        targetList
          .filter((candidate) => !materials.some((material) => material.target === candidate))
          .map((candidate) => {
            const candidatePayload = responsePayload.targetGrants[candidate];
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
  const grantsByTarget = {};
  try {
    for (const material of materials) {
      grantsByTarget[material.target] = {
        ...(await persistLocalMcpGrantTargetMaterial(material)),
        source: "device-authorization"
      };
    }
  } catch {
    const rollback = await rollbackIssuedCredentialMaterials(materials);
    const suffix = rollback.ok
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

function storedIssuerBaseUrl(identity) {
  try {
    return normalizeBaseUrl(String(identity?.baseUrl || ""));
  } catch {
    return "";
  }
}

async function verifyStoredIssuer(identity, verifiedIssuers) {
  const baseUrl = storedIssuerBaseUrl(identity);
  const expected = identity?.issuerIdentity || {};
  if (!baseUrl || !expected.keyId || !expected.publicKeyJwk || !expected.serverId) {
    throw new Error("The stored MCP credential has no verified issuer binding.");
  }
  let discovered = verifiedIssuers.get(baseUrl);
  if (!discovered) {
    discovered = await discoverLicoHub({ url: baseUrl });
    if (!discovered.ok) {
      throw new Error("The stored MCP credential issuer could not be verified.");
    }
    verifiedIssuers.set(baseUrl, discovered);
  }
  const actualIdentity = discovered.handshake?.payload?.identity || {};
  const actualServer = discovered.handshake?.payload?.server || {};
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
}) {
  if (!identity?.privateKeyPem || !identity?.clientIdentityPackage) {
    throw new Error(`No stored MCP process identity is available for ${targetLabel(target)}.`);
  }
  if (!token) {
    throw new Error(`No stored MCP grant credential is available for ${targetLabel(target)}.`);
  }
  if (expectedGrantId && String(identity.grantId || "") !== String(expectedGrantId)) {
    throw new Error(`The stored MCP grant changed before ${targetLabel(target)} rollback.`);
  }
  const issuerBaseUrl = await verifyStoredIssuer(identity, verifiedIssuers);
  const requestUrl = `${issuerBaseUrl}/api/mcp/local-uninstall`;
  const body = JSON.stringify({
    targets: [target],
    connectorVersion: packageJson.version
  });
  const response = await fetchJson(requestUrl, {
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

async function rollbackIssuedCredentialMaterials(materials) {
  const verifiedIssuers = new Map();
  const perTarget = {};
  for (const material of materials) {
    const target = material.target;
    const grantId = String(material.result?.grant?.id || material.identityRecord?.grantId || "");
    try {
      await notifyCredentialUninstall({
        target,
        identity: material.identityRecord,
        token: String(material.result?.token || ""),
        expectedGrantId: grantId,
        verifiedIssuers
      });
      const finalized = await finalizeRevokedLocalMcpCredential(target, grantId);
      perTarget[target] = {
        ...finalized,
        serverGrantRevoked: true
      };
    } catch {
      let retainedForRecovery = false;
      try {
        const existing = await loadProcessIdentity(target);
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
    ok: Object.values(perTarget).every((result) => result.ok === true),
    perTarget
  };
}

export async function notifyLocalMcpUninstall(options, { targets = [], expectedGrantIds = {} } = {}) {
  const targetList = [...new Set(targets.map(normalizeTarget).filter(Boolean))];
  if (targetList.length === 0) {
    return { ok: true, skipped: true, targets: [], perTarget: {} };
  }
  const providedToken = targetList.length === 1
    ? await resolveToken(options, { required: false })
    : "";
  const perTarget = {};
  const verifiedIssuers = new Map();
  for (const target of targetList) {
    try {
      const identity = await loadProcessIdentity(target);
      const expectedGrantId = String(expectedGrantIds[target] || "");
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
      const token = String(identity?.grantToken || "").trim() || providedToken;
      perTarget[target] = await notifyCredentialUninstall({
        target,
        identity,
        token,
        expectedGrantId,
        verifiedIssuers
      });
    } catch (error) {
      const detail = String(error?.message || "");
      const safeDetail = /^(?:No stored MCP|The stored MCP|Failed to update the Meshrix MCP device list)/u.test(detail)
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
    ok: Object.values(perTarget).every((result) => result.ok === true),
    targets: targetList,
    perTarget
  };
}

export async function finalizeRevokedLocalMcpCredential(target, expectedGrantId = "") {
  const identity = await loadProcessIdentity(target);
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
  let revocationMarked = false;
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

function canonicalInstallLocation(settings) {
  const location = String(settings.remoteKind || settings.executionLocation || "local").trim().toLowerCase();
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

export function assertProcessIdentityInstallLocation(options, targets = []) {
  const settings = installerOptions(options);
  const location = canonicalInstallLocation(settings);
  for (const target of [...new Set(targets.map(normalizeTarget).filter(Boolean))]) {
    const supportedLocations = TARGET_LOCATIONS[target] || [];
    if (!supportedLocations.includes(location)) {
      throw new Error(
        `${targetLabel(target)} installation at ${location} is not supported by this release. ` +
        "Use a local connector-managed client so every bearer credential is accompanied by signed process identity; device authorization was not started."
      );
    }
  }
}

function sameIssuerIdentity(left, right) {
  return Boolean(
    left?.keyId &&
    right?.keyId &&
    String(left.keyId) === String(right.keyId) &&
    String(left.serverId || "") === String(right.serverId || "") &&
    stableStringify(left.publicKeyJwk || {}) === stableStringify(right.publicKeyJwk || {})
  );
}

async function storedGrantForInstall(options, settings, target) {
  const identity = await loadProcessIdentity(target);
  if (!identity) {
    return null;
  }
  const token = String(identity.grantToken || "").trim();
  const grantId = String(identity.grantId || "").trim();
  const issuerBaseUrl = storedIssuerBaseUrl(identity);
  const currentIssuer = issuerIdentityFromDiscovery(options.__licoDiscovery);
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

export async function resolveInstallToken(options, { targets = [], autoUpdate = false } = {}) {
  assertProcessIdentityInstallLocation(options, targets);
  const explicit = await resolveToken(options, { required: false });
  if (explicit) {
    return {
      token: explicit,
      source: "provided",
      tokenPrefix: redactToken(explicit)
    };
  }
  if (options["no-auto-token"]) {
    const tokenEnv = String(option(options, "token-env", DEFAULT_TOKEN_ENV));
    throw new Error(`Missing token. Provide --token-stdin or ${tokenEnv}.`);
  }
  const targetList = [...new Set(targets.map(normalizeTarget).filter(Boolean))];
  if (targetList.length === 0) {
    throw new Error("Local MCP installation requires at least one target.");
  }
  const settings = installerOptions(options);
  const existingByTarget = {};
  const missingTargets = [];
  for (const target of targetList) {
    const existing = await storedGrantForInstall(options, settings, target);
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
  const issued = missingTargets.length > 0
    ? await requestLocalMcpGrantBatch(options, { targets: missingTargets, autoUpdate })
    : { grantsByTarget: {} };
  const grantsByTarget = {
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

export async function resolveHubForInstall(options) {
  const discovered = await discoverLicoHub(options);
  if (discovered.ok) {
    return {
      ...options,
      "resolved-url": discovered.baseUrl,
      __licoDiscovery: discovered
    };
  }
  if (!canUseInstallTui(options)) {
    throw new Error(`${discovered.reason} Run meshrix-mcp server-config --set --url <meshrix-url>, or rerun install in a TTY and choose manual configuration.`);
  }
  console.log("No signed Meshrix MCP service was discovered on this device.");
  console.log("The installer will not write any agent client config until a server identity signature is verified.");
  console.log("");
  const answer = await promptLine("Choose: [c]onfigure server URL now, [s]kip, manually configure later [s]: ");
  if (!answer || answer.toLowerCase().startsWith("s")) {
    return {
      ...options,
      __licoSkippedDiscovery: {
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
  const url = await promptLine("Meshrix server URL: ");
  const manual = await discoverLicoHub({ ...options, url });
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
    __licoDiscovery: manual
  };
}

export function remoteContextFromSettings(settings) {
  const kind = settings.remoteKind || settings.executionLocation;
  if (!isGenericRemoteLocation(kind)) {
    return null;
  }
  const remoteBins = {
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
  const bin = settings.remoteBin
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
