import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";

export const SAMPLE_CAPABILITY_PACK_PROTOCOL_VERSION: any = "v0.0.1:platform:sample-capability-pack-1";

const DEFAULT_PACK_ID: any = "gateway-forwarding-pilot";
const SAMPLE_PACK_ROOT: any = "sample-capability-packs";

function nowIso() : any {
  return new Date().toISOString();
}

function text(value?: any) : any {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function slug(value?: any) : any {
  return text(value).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "sample";
}

function sha256(buffer?: any) : any {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function asBuffer(value?: any) : any {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
}

const SAMPLE_PACKS: readonly any[] = Object.freeze([
  {
    packId: DEFAULT_PACK_ID,
    title: "Gateway Forwarding Pilot",
    description: "覆盖上游 API 注册、审批策略、限流和调用预览的服务端样例能力包。",
    capabilityDomain: "service-gateway-governance",
    tags: ["gateway", "governance", "approval"],
    assets: [
      {
        relativePath: "gateway/upstreams/catalog.json",
        category: "gateway_config",
        mediaType: "application/json",
        routeRole: "upstream-registry",
        governanceRole: "registration",
        description: "示例上游 API 注册清单。",
        content: () : any => JSON.stringify({
          upstreams: [
            {
              upstreamId: "billing-status",
              method: "GET",
              path: "/v1/accounts/{accountId}/status",
              timeoutMs: 5000,
              requiredScopes: ["gateway:read"]
            },
            {
              upstreamId: "ticket-create",
              method: "POST",
              path: "/v1/tickets",
              timeoutMs: 8000,
              requiredScopes: ["gateway:write"],
              approvalRequired: true
            }
          ]
        }, null, 2)
      },
      {
        relativePath: "gateway/policies/approval-policy.json",
        category: "policy",
        mediaType: "application/json",
        routeRole: "policy-preview",
        governanceRole: "approval",
        description: "示例审批策略，约束写入类上游调用。",
        content: () : any => JSON.stringify({
          policyId: "write-call-approval",
          match: { requiredScopes: ["gateway:write"] },
          decision: "approval_required",
          approverRole: "gateway-admin"
        }, null, 2)
      },
      {
        relativePath: "gateway/traffic/limits.json",
        category: "traffic_control",
        mediaType: "application/json",
        routeRole: "traffic-control",
        governanceRole: "rate-limit",
        description: "示例流量控制规则。",
        content: () : any => JSON.stringify({
          rules: [
            { upstreamId: "billing-status", perMinute: 120, burst: 20 },
            { upstreamId: "ticket-create", perMinute: 30, burst: 5 }
          ]
        }, null, 2)
      },
      {
        relativePath: "gateway/examples/request-preview.json",
        category: "request_preview",
        mediaType: "application/json",
        routeRole: "policy-preview",
        governanceRole: "audit",
        description: "示例调用预览输入。",
        content: () : any => JSON.stringify({
          upstreamId: "ticket-create",
          subject: { actorId: "operator-demo", scopes: ["gateway:write"] },
          request: {
            method: "POST",
            path: "/v1/tickets",
            bodyShape: { title: "string", priority: "enum" }
          }
        }, null, 2)
      },
      {
        relativePath: "gateway/operator-checklist.md",
        category: "operator_checklist",
        mediaType: "text/markdown",
        routeRole: "operator-guide",
        governanceRole: "handoff",
        description: "网关样例上线检查清单。",
        content: () : any => [
          "# Gateway Forwarding Pilot",
          "",
          "本样例用于验证 Meshrix 对上游 API 注册、策略预览、审批和流控的整合能力。",
          "",
          "## 检查项",
          "",
          "- 上游接口已在服务端配置并绑定最小 scopes。",
          "- 写入类调用会进入审批队列。",
          "- 流量规则已启用并写入审计。",
          "- MCP outlet 只暴露授权后的 gateway tools。"
        ].join("\n")
      }
    ],
    rolloutPlan: [
      {
        stepId: "register-upstreams",
        source: "gateway/upstreams/catalog.json",
        route: "operation-permission.catalog",
        expectedSignals: ["upstream-id", "method", "scope-binding"]
      },
      {
        stepId: "preview-policy",
        source: "gateway/examples/request-preview.json",
        route: "operation-permission.policy.preview",
        expectedSignals: ["decision", "approval-required", "audit-redaction"]
      },
      {
        stepId: "enforce-traffic",
        source: "gateway/traffic/limits.json",
        route: "gateway.traffic.control",
        expectedSignals: ["quota", "burst", "audit-event"]
      }
    ]
  }
]);

function getPackDefinition(packId: any = DEFAULT_PACK_ID) : any {
  const selected: any = slug(packId || DEFAULT_PACK_ID);
  return SAMPLE_PACKS.find((pack?: any) : any => pack.packId === selected) || null;
}

function buildAsset(asset?: any) : any {
  const content: any = asBuffer(asset.content());
  return {
    relativePath: asset.relativePath,
    category: asset.category,
    mediaType: asset.mediaType,
    routeRole: asset.routeRole,
    governanceRole: asset.governanceRole,
    description: asset.description,
    bytes: content.length,
    sha256: sha256(content)
  };
}

function buildManifest(pack?: any) : any {
  const assets: any = pack.assets.map(buildAsset);
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: SAMPLE_CAPABILITY_PACK_PROTOCOL_VERSION,
    packId: pack.packId,
    title: pack.title,
    description: pack.description,
    capabilityDomain: pack.capabilityDomain,
    tags: pack.tags,
    assetCount: assets.length,
    assetCategories: [...new Set<any>(assets.map((asset?: any) : any => asset.category))],
    assets,
    rolloutPlan: pack.rolloutPlan
  };
}

export function listSampleCapabilityPacks() : any {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: SAMPLE_CAPABILITY_PACK_PROTOCOL_VERSION,
    packs: SAMPLE_PACKS.map((pack?: any) : any => {
      const manifest: any = buildManifest(pack);
      return {
        packId: manifest.packId,
        title: manifest.title,
        description: manifest.description,
        capabilityDomain: manifest.capabilityDomain,
        tags: manifest.tags,
        assetCount: manifest.assetCount,
        assetCategories: manifest.assetCategories
      };
    })
  };
}

export function getSampleCapabilityPack(packId: any = DEFAULT_PACK_ID) : any {
  const pack: any = getPackDefinition(packId);
  if (!pack) return null;
  return buildManifest(pack);
}

function assertSafeRelativePath(relativePath?: any) : any {
  const value: any = String(relativePath || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || value.split("/").includes("..")) {
    throw new Error(`Unsafe sample capability pack path: ${relativePath}`);
  }
  return value;
}

function isInside(basePath?: any, targetPath?: any) : any {
  const relative: any = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function materializeRoot(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const baseRoot: any = path.resolve(options.userDataPath || ServerConfig.getDataDir(), SAMPLE_PACK_ROOT);
  const packId: any = slug(input.packId || DEFAULT_PACK_ID);
  const defaultRunId: any = `${packId}-${nowIso().replace(/[:.]/g, "-")}`;
  const requested: any = text(input.targetRoot || input.outputDirectory || "");
  const targetRoot: any = requested
    ? path.resolve(baseRoot, requested)
    : path.join(baseRoot, defaultRunId);
  if (!isInside(baseRoot, targetRoot)) {
    throw new Error("targetRoot must stay inside the sample capability pack data directory.");
  }
  return { baseRoot, targetRoot };
}

async function writeSampleFile(filePath?: any, content?: any, overwrite: any = false) : Promise<any> {
  if (!overwrite) {
    try {
      await fs.access(filePath);
      throw new Error(`Refusing to overwrite existing sample file: ${filePath}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

export async function materializeSampleCapabilityPack(input: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
  const packId: any = slug(input.packId || DEFAULT_PACK_ID);
  const pack: any = getPackDefinition(packId);
  if (!pack) {
    throw new Error(`Unknown sample capability pack: ${packId}`);
  }
  const overwrite: any = input.overwrite === true;
  const { targetRoot } = materializeRoot({ ...input, packId }, options);
  const manifest: any = buildManifest(pack);
  const writtenFiles: any[] = [];
  for (const asset of pack.assets) {
    const relativePath: any = assertSafeRelativePath(asset.relativePath);
    const content: any = asBuffer(asset.content());
    const filePath: any = path.join(targetRoot, relativePath);
    await writeSampleFile(filePath, content, overwrite);
    writtenFiles.push({
      relativePath,
      absolutePath: filePath,
      category: asset.category,
      mediaType: asset.mediaType,
      bytes: content.length,
      sha256: sha256(content)
    });
  }
  const manifestPath: any = path.join(targetRoot, "manifest.json");
  await writeSampleFile(
    manifestPath,
    Buffer.from(`${JSON.stringify({ ...manifest, materializedAt: nowIso(), writtenFiles }, null, 2)}\n`, "utf8"),
    overwrite
  );
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: SAMPLE_CAPABILITY_PACK_PROTOCOL_VERSION,
    packId: manifest.packId,
    targetRoot,
    manifestPath,
    writtenFiles,
    rolloutPlan: manifest.rolloutPlan
  };
}

export function createSampleCapabilityPackStore({ userDataPath }: Record<string, any> = {}) : any {
  return {
    list: listSampleCapabilityPacks,
    get: getSampleCapabilityPack,
    materialize(input: Record<string, any> = {}) : any {
      return materializeSampleCapabilityPack(input, { userDataPath });
    }
  };
}
