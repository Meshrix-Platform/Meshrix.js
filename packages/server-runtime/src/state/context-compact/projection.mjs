import {
  asArray,
  asObject,
  clampNumber,
  estimateContextTokens,
  findSensitiveCompactionLeaks,
  hashValue,
  normalizeText,
  redactCompactionValue,
  redactEmbeddedPayloads,
  redactText
} from "./validation.mjs";
import { normalizeMessage, toolResultIds, toolUseIds } from "./graph.mjs";

export function extractMatches(text, regex, limit = 20) {
  return [...new Set((String(text || "").match(regex) || []).map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

export function selectImportantLines(text, limit = 8) {
  const lines = String(text || "")
    .split(/\r?\n|(?<=[。！？.!?])\s+/u)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const scored = lines.map((line, index) => ({
    line,
    index,
    score:
      /(must|should|never|cannot|todo|fixme|risk|error|failed|decision|approved|evidence|source|scope|rollback|version|必须|不能|不得|风险|错误|失败|决定|证据|来源|审批|版本|回滚)/i.test(line)
        ? 3
        : /(\/[\w./-]+|[A-Za-z]:\\|[A-Z][A-Za-z0-9_/-]+\.(?:mjs|js|ts|tsx|json|rs|dart|swift|md)|\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b)/.test(line)
          ? 2
          : 1
  }));
  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.line);
}

export function compactToBudget(text, targetTokens) {
  const safeTarget = Math.max(0, Number(targetTokens || 0));
  const source = redactText(String(text || "").trim());
  if (safeTarget === 0) {
    return "";
  }
  if (!source || estimateContextTokens(source) <= safeTarget) {
    return source;
  }
  const lines = selectImportantLines(source, Math.max(6, Math.floor(safeTarget / 90)));
  let output = lines.join("\n");
  while (estimateContextTokens(output) > safeTarget && output.length > 80) {
    output = output.slice(0, Math.floor(output.length * 0.85)).trim();
  }
  return output || source.slice(0, safeTarget * 4);
}

export function collectStructuredFacts(messages = [], runtimeState = {}) {
  const joined = messages.map((message) => `${message.role}: ${message.text}`).join("\n");
  return {
    constraints: extractMatches(
      joined,
      /(?:must|should|never|cannot|do not|必须|不能|不得|需要|确保)[^。！？.!?\n]{0,220}/gi,
      24
    ),
    decisions: extractMatches(
      joined,
      /(?:decision|decided|approved|rejected|决定|已确认|已批准|已拒绝)[^。！？.!?\n]{0,220}/gi,
      18
    ),
    risks: extractMatches(
      joined,
      /(?:risk|error|failed|failure|blocked|warning|风险|错误|失败|阻塞|告警)[^。！？.!?\n]{0,220}/gi,
      24
    ),
    todos: extractMatches(
      joined,
      /(?:todo|fixme|pending|next|follow[- ]?up|待办|未完成|下一步|待审批)[^。！？.!?\n]{0,220}/gi,
      24
    ),
    evidenceRefs: extractMatches(
      joined,
      /\b(?:ev|evidence|source|doc|chunk|record|audit|run|job|pkg|version)[-_:#]?[A-Za-z0-9_.:-]{2,80}\b/gi,
      40
    ),
    fileRefs: extractMatches(
      joined,
      /(?:[A-Za-z]:\\[^\s"'<>]+|\/[^\s"'<>]+\.(?:mjs|js|ts|tsx|json|rs|dart|swift|md|yaml|yml)|\b[\w./-]+\.(?:mjs|js|ts|tsx|json|rs|dart|swift|md|yaml|yml)\b)/g,
      32
    ).map(redactText),
    dates: extractMatches(joined, /\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?\b|\b\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}\b/g, 20),
    amounts: extractMatches(joined, /(?:[$€£¥￥]\s*)?\d[\d,]*(?:\.\d+)?\s*(?:美元|美金|人民币|元|GBP|USD|EUR|CNY|%|percent)?/gi, 20),
    gatewayRefs: [
      runtimeState.gatewayReference,
      runtimeState.gatewayPolicyVersion,
      runtimeState.gatewaySourceId
    ].map((item) => String(item || "").trim()).filter(Boolean)
  };
}

export function normalizeRequiredAnchors(input = {}, runtimeState = {}) {
  const rawAnchors = [
    ...asArray(input.requiredAnchors),
    ...asArray(input.requiredFacts),
    ...asArray(input.protectedAnchors),
    ...asArray(input.compactionQuality?.requiredAnchors),
    ...asArray(runtimeState.requiredAnchors)
  ];
  const seen = new Set();
  return rawAnchors
    .map((anchor) => {
      const source = typeof anchor === "string"
        ? { text: anchor }
        : asObject(anchor);
      const text = normalizeText(source.text || source.value || source.anchor || source.id || "");
      if (!text) {
        return null;
      }
      const id = normalizeText(source.id || source.key || text).slice(0, 120);
      const key = `${id}\u001f${text}`.toLowerCase();
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);
      return {
        id,
        text: compactToBudget(text, 120)
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

export function retainedTextForQuality({ summary = "", messagesToKeep = [], reinjection = {} } = {}) {
  return [
    summary,
    ...asArray(messagesToKeep).map((message) =>
      typeof message === "string" ? message : (message.text || message.content || JSON.stringify(message))
    ),
    ...asArray(reinjection.items).map((item) =>
      typeof item?.value === "string" ? item.value : JSON.stringify(item?.value ?? "")
    )
  ].join("\n");
}

export function buildCompactionQualityReport({
  input = {},
  runtimeState = {},
  summary = "",
  messagesToKeep = [],
  reinjection = {},
  tokenReport = null
} = {}) {
  const requiredAnchors = normalizeRequiredAnchors(input, runtimeState);
  const retainedRawText = retainedTextForQuality({ summary, messagesToKeep, reinjection });
  const retainedText = normalizeText(retainedRawText).toLowerCase();
  const retained = [];
  const missing = [];
  for (const anchor of requiredAnchors) {
    const matched = anchor.text && retainedText.includes(normalizeText(anchor.text).toLowerCase());
    (matched ? retained : missing).push(anchor);
  }
  const secretMatches = findSensitiveCompactionLeaks(retainedRawText);
  const minimumRetentionRatio = clampNumber(
    input.compactionQuality?.minimumRetentionRatio,
    1,
    0,
    1
  );
  const retentionRatio = requiredAnchors.length
    ? Number((retained.length / requiredAnchors.length).toFixed(6))
    : 1;
  return {
    protocolVersion: "v0.0.1:agent:context-compaction-quality-1",
    requiredAnchorCount: requiredAnchors.length,
    retainedAnchorCount: retained.length,
    missingAnchorCount: missing.length,
    retentionRatio,
    minimumRetentionRatio,
    missingAnchors: missing.slice(0, 20),
    retainedAnchors: retained.slice(0, 20),
    secretLeakCount: secretMatches.length,
    compressionSavingsRatio: Number(tokenReport?.savingsRatio || 0),
    passed: retentionRatio >= minimumRetentionRatio && secretMatches.length === 0
  };
}

export function buildDeterministicSummary({
  messages = [],
  runtimeState = {},
  targetTokens,
  compactedRange = {}
}) {
  const facts = collectStructuredFacts(messages, runtimeState);
  const messageSummaries = messages.slice(-60).map((message) => {
    const lines = selectImportantLines(message.text, 4);
    const toolIds = [...toolUseIds(message), ...toolResultIds(message)];
    return {
      id: message.id,
      role: message.role,
      apiRoundId: message.apiRoundId,
      toolIds,
      summary: compactToBudget(lines.join("\n") || message.text, 180)
    };
  }).filter((item) => item.summary || item.toolIds.length);
  const structured = {
    kind: "context_compaction_summary",
    sourceRange: compactedRange,
    taskBrief: runtimeState.taskBrief || runtimeState.task || "",
    activePlan: runtimeState.activePlan || null,
    facts,
    messages: messageSummaries
  };
  const summary = [
    "Context compaction summary. This is auxiliary memory, not canonical evidence.",
    `Source range: ${compactedRange.startMessageId || ""}..${compactedRange.endMessageId || ""}`,
    runtimeState.taskBrief ? `Current task: ${runtimeState.taskBrief}` : "",
    facts.constraints.length ? `Constraints:\n- ${facts.constraints.map(redactText).join("\n- ")}` : "",
    facts.decisions.length ? `Decisions:\n- ${facts.decisions.map(redactText).join("\n- ")}` : "",
    facts.risks.length ? `Risks/errors:\n- ${facts.risks.map(redactText).join("\n- ")}` : "",
    facts.todos.length ? `Open items:\n- ${facts.todos.map(redactText).join("\n- ")}` : "",
    facts.evidenceRefs.length ? `Evidence/source refs: ${facts.evidenceRefs.join(", ")}` : "",
    facts.fileRefs.length ? `File refs: ${facts.fileRefs.join(", ")}` : "",
    facts.gatewayRefs.length ? `Gateway refs: ${facts.gatewayRefs.join(", ")}` : "",
    "Message notes:",
    ...messageSummaries.slice(-24).map((item) => `- [${item.role} ${item.id}] ${item.summary}`)
  ].filter(Boolean).join("\n");
  return {
    summary: compactToBudget(summary, targetTokens),
    structured: redactCompactionValue(structured)
  };
}

export function parseModelSummary(value) {
  const text = String(value?.summary || value?.answer || value?.text || value || "").trim();
  if (!text) {
    throw new Error("model_compaction_empty");
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.match(/\{[\s\S]*\}/)?.[0] || "";
  if (!candidate) {
    throw new Error("model_compaction_json_missing");
  }
  const parsed = JSON.parse(candidate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("model_compaction_schema_invalid");
  }
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("model_compaction_summary_missing");
  }
  return {
    summary: parsed.summary,
    structured: parsed
  };
}

export function messagesByApiRound(messages = []) {
  const groups = [];
  let current = null;
  for (const message of messages) {
    if (!current || current.apiRoundId !== message.apiRoundId) {
      current = { apiRoundId: message.apiRoundId, messages: [] };
      groups.push(current);
    }
    current.messages.push(message);
  }
  return groups;
}

export function modelInputForAttempt(messages = [], attempt = 0, maxInputTokens = 0) {
  if (!Number.isFinite(Number(maxInputTokens)) || Number(maxInputTokens) <= 0) {
    return [];
  }
  let groups = messagesByApiRound(messages);
  for (let drop = 0; drop < attempt && groups.length > 1; drop += 1) {
    groups = groups.slice(1);
  }
  let candidate = groups.flatMap((group) => group.messages);
  while (candidate.length > 1 && estimateContextTokens(candidate.map((message) => message.text).join("\n")) > maxInputTokens) {
    const nextGroups = messagesByApiRound(candidate).slice(1);
    candidate = nextGroups.length ? nextGroups.flatMap((group) => group.messages) : candidate.slice(1);
  }
  return estimateContextTokens(candidate.map((message) => message.text).join("\n")) <= maxInputTokens
    ? candidate
    : [];
}

export function workbenchInputForAttempt(messages = [], attempt = 0, maxInputTokens = 0, trimRatio = 0) {
  if (!Number.isFinite(Number(maxInputTokens)) || Number(maxInputTokens) <= 0) {
    return {
      messages: [],
      metadata: { droppedGroupCount: messagesByApiRound(messages).length, trimRatio, inputTokens: 0 }
    };
  }
  let groups = messagesByApiRound(messages);
  const originalGroupCount = groups.length;
  if (attempt > 0 && groups.length > 1) {
    const dropCount = Math.min(
      groups.length - 1,
      Math.max(1, Math.ceil(groups.length * trimRatio * attempt))
    );
    groups = groups.slice(dropCount);
  }
  let droppedGroupCount = originalGroupCount - groups.length;
  let candidate = groups.flatMap((group) => group.messages);
  while (
    candidate.length > 1 &&
    estimateContextTokens(candidate.map((message) => message.text).join("\n")) > maxInputTokens
  ) {
    const nextGroups = messagesByApiRound(candidate);
    const dropCount = Math.min(
      nextGroups.length - 1,
      Math.max(1, Math.ceil(nextGroups.length * trimRatio))
    );
    if (dropCount <= 0) {
      candidate = candidate.slice(1);
      droppedGroupCount += 1;
      continue;
    }
    groups = nextGroups.slice(dropCount);
    droppedGroupCount += dropCount;
    candidate = groups.length ? groups.flatMap((group) => group.messages) : candidate.slice(1);
  }
  const withinBudget = estimateContextTokens(candidate.map((message) => message.text).join("\n")) <= maxInputTokens;
  const selected = withinBudget ? candidate : [];
  return {
    messages: selected,
    metadata: {
      droppedGroupCount,
      trimRatio,
      inputTokens: estimateContextTokens(selected.map((message) => message.text).join("\n"))
    }
  };
}

export function buildModelPrompt({ messages, runtimeState, targetTokens, compactedRange }) {
  const payload = messages.map((message) => ({
    id: message.id,
    role: message.role,
    apiRoundId: message.apiRoundId,
    text: redactText(message.text),
    toolUseIds: toolUseIds(message),
    toolResultIds: toolResultIds(message)
  }));
  return [
    "You are LicoMesh ContextCompactionRuntime.",
    "Compress context only. Do not invent facts. The output is auxiliary memory, not canonical evidence.",
    "Preserve user constraints, decisions, errors, TODOs, evidence/source ids, dates, amounts, file refs, tool call ids, and gateway references.",
    "Return strict JSON with keys: summary, constraints, decisions, risks, todos, evidenceRefs, fileRefs, gatewayRefs.",
    `Target tokens: ${targetTokens}`,
    `Source range: ${compactedRange.startMessageId || ""}..${compactedRange.endMessageId || ""}`,
    runtimeState.taskBrief ? `Current task: ${redactText(runtimeState.taskBrief)}` : "",
    JSON.stringify(payload)
  ].filter(Boolean).join("\n");
}

export function buildReinjectionPayload({ input = {}, runtimeState = {}, policy }) {
  const source = {
    ...asObject(input.runtimeState),
    ...runtimeState
  };
  const candidates = [
    ["taskBrief", source.taskBrief || input.taskBrief || input.task || input.query || "", 100],
    ["activePlan", source.activePlan || input.activePlan || input.plan || "", 95],
    ["activeSkill", source.activeSkill || input.activeSkill || "", 88],
    ["activeToolUseIds", source.activeToolUseIds || input.activeToolUseIds || "", 84],
    ["openToolCalls", source.openToolCalls || input.openToolCalls || "", 82],
    ["enabledTools", source.enabledTools || input.enabledTools || input.tools || "", 80],
    ["operationCatalog", source.operationCatalog || input.operationCatalog || "", 75],
    ["currentFiles", source.currentFiles || input.currentFiles || "", 70],
    ["fileAttachments", source.fileAttachments || input.fileAttachments || "", 68],
    ["gatewayReference", source.gatewayReference || input.gatewayReference || "", 65],
    ["mcpServers", source.mcpServers || input.mcpServers || "", 64],
    ["deferredToolDeltas", source.deferredToolDeltas || input.deferredToolDeltas || "", 62],
    ["maintenanceRun", source.maintenanceRun || input.maintenanceRun || "", 60],
    ["recentError", source.recentError || input.recentError || "", 55],
    ["worktreeState", source.worktreeState || input.worktreeState || "", 54],
    ["userConstraints", source.userConstraints || input.userConstraints || "", 50]
  ]
    .map(([key, value, priority]) => ({ key, value: redactCompactionValue(value), priority }))
    .filter((item) => item.value && estimateContextTokens(item.value) > 1);

  const selected = [];
  const dropped = [];
  let usedTokens = 0;
  for (const item of candidates.sort((left, right) => right.priority - left.priority)) {
    const tokens = estimateContextTokens(item.value);
    if (usedTokens + tokens > policy.reinjectionBudgetTokens) {
      dropped.push({ key: item.key, reason: "reinjection_budget_exceeded", tokens });
      continue;
    }
    selected.push({ key: item.key, value: item.value, tokens, priority: item.priority });
    usedTokens += tokens;
  }
  return {
    items: selected,
    usedTokens,
    dropped,
    degraded: dropped.length > 0,
    budgetTokens: policy.reinjectionBudgetTokens
  };
}

export function dehydrateAttachment(attachment = {}, policy) {
  const ref = attachment.ref || attachment.artifactRef || attachment.path || attachment.url || attachment.name || attachment.fileName || "";
  const summary = compactToBudget(
    attachment.summary || attachment.text || attachment.description || JSON.stringify(attachment),
    policy.maxAttachmentTokens
  );
  return {
    type: attachment.type || attachment.mediaType || "attachment",
    name: attachment.name || attachment.fileName || "",
    ref: redactText(String(ref || "")),
    checksum: attachment.checksum || attachment.sha256 || hashValue({ ref, summary }, 16),
    summary,
    dehydrated: true
  };
}

export function isHeavyContentBlock(value = {}) {
  const block = asObject(value);
  const type = String(block.type || block.mediaType || block.kind || "").toLowerCase();
  return /image|document|attachment|binary|pdf|audio|video/.test(type) ||
    Boolean(block.data || block.dataBase64 || block.base64 || block.bytes || block.buffer);
}

export function dehydrateContentBlock(block = {}, policy) {
  const source = asObject(block);
  const ref = source.ref || source.path || source.url || source.name || source.fileName || "";
  const originalType = String(source.type || source.mediaType || source.kind || "attachment");
  const summary = compactToBudget(
    source.summary || source.text || source.description || source.title || JSON.stringify({
      type: originalType,
      name: source.name || source.fileName || "",
      ref
    }),
    policy.maxAttachmentTokens
  );
  return {
    type: "dehydrated_payload",
    originalType,
    name: source.name || source.fileName || "",
    ref: redactText(String(ref || "")),
    checksum: source.checksum || source.sha256 || hashValue({ originalType, ref, summary }, 16),
    summary,
    dehydrated: true
  };
}

export function stripHeavyPayloadsFromMessage(message = {}, policy) {
  let strippedBlockCount = 0;
  let dehydratedAttachmentCount = 0;
  const next = {
    ...message,
    text: redactEmbeddedPayloads(message.text || "")
  };

  if (Array.isArray(message.content)) {
    next.content = message.content.map((item) => {
      if (isHeavyContentBlock(item)) {
        strippedBlockCount += 1;
        return dehydrateContentBlock(item, policy);
      }
      if (typeof item === "string") {
        return redactEmbeddedPayloads(item);
      }
      if (item && typeof item === "object") {
        return {
          ...item,
          text: item.text ? redactEmbeddedPayloads(item.text) : item.text,
          content: typeof item.content === "string" ? redactEmbeddedPayloads(item.content) : item.content
        };
      }
      return item;
    });
  } else if (typeof message.content === "string") {
    next.content = redactEmbeddedPayloads(message.content);
  } else if (isHeavyContentBlock(message.content)) {
    strippedBlockCount += 1;
    next.content = dehydrateContentBlock(message.content, policy);
  }

  if (Array.isArray(message.blocks)) {
    next.blocks = message.blocks.map((block) => {
      if (isHeavyContentBlock(block)) {
        strippedBlockCount += 1;
        return dehydrateContentBlock(block, policy);
      }
      if (block && typeof block === "object") {
        return {
          ...block,
          text: block.text ? redactEmbeddedPayloads(block.text) : block.text,
          content: typeof block.content === "string" ? redactEmbeddedPayloads(block.content) : block.content
        };
      }
      return block;
    });
  }

  if (Array.isArray(message.attachments)) {
    next.attachments = message.attachments.map((attachment) => {
      if (isHeavyContentBlock(attachment) || estimateContextTokens(attachment) > policy.maxAttachmentTokens) {
        dehydratedAttachmentCount += 1;
        return dehydrateAttachment(attachment, policy);
      }
      return attachment;
    });
  }

  const normalized = normalizeMessage(next, message.index || 0);
  return {
    message: {
      ...normalized,
      index: message.index,
      apiRoundId: message.apiRoundId,
      id: message.id
    },
    strippedBlockCount,
    dehydratedAttachmentCount
  };
}

export function prepareWorkbenchMessages(messages = [], policy) {
  const prepared = [];
  let strippedBlockCount = 0;
  let dehydratedAttachmentCount = 0;
  for (const message of messages) {
    const result = stripHeavyPayloadsFromMessage(message, policy);
    strippedBlockCount += result.strippedBlockCount;
    dehydratedAttachmentCount += result.dehydratedAttachmentCount;
    prepared.push(result.message);
  }
  const originalTokens = estimateContextTokens(messages.map((message) => message.text).join("\n"));
  const preparedTokens = estimateContextTokens(prepared.map((message) => message.text).join("\n"));
  return {
    messages: prepared,
    strippedBlockCount,
    dehydratedAttachmentCount,
    changedCount: strippedBlockCount + dehydratedAttachmentCount,
    originalTokens,
    preparedTokens,
    savedTokens: Math.max(0, originalTokens - preparedTokens)
  };
}

export function summarizeToolResult(message = {}, policy) {
  const text = message.text || "";
  return {
    ...message,
    content: `[tool_result dehydrated: ${compactToBudget(text, policy.maxToolResultTokens)}]`,
    text: compactToBudget(text, policy.maxToolResultTokens),
    dehydrated: true,
    originalTokenEstimate: message.tokenEstimate,
    tokenEstimate: Math.min(message.tokenEstimate, policy.maxToolResultTokens)
  };
}

export function microCompactMessages(messages = [], { policy, activeToolUseIds = [] } = {}) {
  if (!policy.microCompaction) {
    return {
      messages,
      changedCount: 0,
      dehydratedAttachments: []
    };
  }
  const activeSet = new Set(asArray(activeToolUseIds).map((item) => String(item)));
  const protectedStart = Math.max(0, messages.length - policy.recentMessageProtectionCount);
  const dehydratedAttachments = [];
  const compacted = messages.map((message, index) => {
    let next = message;
    const messageToolIds = [...toolUseIds(message), ...toolResultIds(message)];
    const isProtected = index >= protectedStart ||
      messageToolIds.some((id) => activeSet.has(id)) ||
      (/error|failed|failure|异常|失败/i.test(message.text) && index >= Math.max(0, messages.length - policy.recentMessageProtectionCount * 2));

    if (!isProtected && (message.role === "tool" || message.type === "tool_result") && message.tokenEstimate > policy.maxToolResultTokens) {
      next = summarizeToolResult(message, policy);
    }

    if (policy.allowAttachmentDehydration && asArray(next.attachments).length) {
      const attachments = next.attachments.map((attachment) => {
        const tokens = estimateContextTokens(attachment);
        if (tokens <= policy.maxAttachmentTokens) {
          return attachment;
        }
        const dehydrated = dehydrateAttachment(attachment, policy);
        dehydratedAttachments.push(dehydrated);
        return dehydrated;
      });
      next = {
        ...next,
        attachments
      };
    }
    return next;
  });
  const changedCount = compacted.filter((message, index) => message !== messages[index]).length;
  return {
    messages: compacted,
    changedCount,
    dehydratedAttachments
  };
}
