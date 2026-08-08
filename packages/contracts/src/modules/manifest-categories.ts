export const ARCHITECTURE_FACT_MANIFEST_VERSION: any = "v0.0.1:architecture:fact-manifest-1";

export const ARCHITECTURE_MODULE_CATEGORY_DEFINITIONS: readonly any[] = Object.freeze([
  Object.freeze({
    categoryId: "foundation",
    label: "基础模块",
    description: "Platform substrate that cannot be removed without breaking Meshrix.js runtime and hydration mechanics."
  }),
  Object.freeze({
    categoryId: "core-capability",
    label: "核心能力",
    description: "Platform capability domain. Essential records are mandatory; optional records may be dehydrated with their function removed."
  }),
  Object.freeze({
    categoryId: "application",
    label: "应用模块",
    description: "Independent application capability. Removing it removes that standalone feature without breaking the platform."
  }),
  Object.freeze({
    categoryId: "aspect",
    label: "切面模块",
    description: "Protocol, request, projection, and routing surfaces around platform and application capabilities."
  }),
  Object.freeze({
    categoryId: "appearance",
    label: "外观入口",
    description: "Control-panel presentation surface that calls application or aspect entry points."
  })
]);

export const ARCHITECTURE_MODULE_CATEGORY_BY_LAYER: Readonly<Record<string, any>> = Object.freeze({
  appearance: "appearance",
  "platform-capabilities": "core-capability",
  application: "application",
  aspect: "aspect",
  foundation: "foundation"
});

export const DOCUMENTATION_ASSET_CLASSIFICATIONS: readonly any[] = Object.freeze([
  Object.freeze({
    assetId: "product-readme",
    classification: "promotional",
    paths: Object.freeze(["README.md", "README.zh-CN.md"]),
    purpose: "Product introduction, positioning, quick start, and public-facing capability summary.",
    factAuthority: "not-authoritative-for-architecture-hydration"
  }),
  Object.freeze({
    assetId: "product-visual-assets",
    classification: "promotional",
    paths: Object.freeze([
      "docs/banner.svg",
      "docs/logo.svg",
      "docs/architecture-overview.svg"
    ]),
    purpose: "README and product-page visuals. They explain the product but do not define module boundaries.",
    factAuthority: "not-authoritative-for-architecture-hydration"
  }),
  Object.freeze({
    assetId: "developer-doc-index",
    classification: "developer-documentation",
    paths: Object.freeze(["docs/README.md"]),
    purpose: "Runtime documentation entry point.",
    factAuthority: "documentation-index"
  }),
  Object.freeze({
    assetId: "architecture-html-diagrams",
    classification: "developer-documentation",
    paths: Object.freeze([
      "docs/architecture/MESHRIX-SYSTEM-ARCHITECTURE.html",
      "docs/architecture/MESHRIX-SERVICE-CAPABILITY-ARCHITECTURE.html"
    ]),
    purpose: "Human-readable architecture diagrams for system layers, service capability flow, and hydration status.",
    factAuthority: "source-material-for-architecture-facts"
  }),
  Object.freeze({
    assetId: "architecture-fact-manifest",
    classification: "developer-documentation",
    paths: Object.freeze(["packages/contracts/src/modules/manifest.ts"]),
    purpose: "Machine-readable architecture fact source consumed by verifiers and agents.",
    factAuthority: "authoritative-for-architecture-hydration"
  }),
  Object.freeze({
    assetId: "execution-sandbox-target-architecture",
    classification: "developer-documentation",
    paths: Object.freeze(["docs/architecture/EXECUTION-SANDBOX.md"]),
    purpose: "Default-deny target contract for governed executable workloads; it does not assert runtime implementation or readiness.",
    factAuthority: "authoritative-for-target-execution-sandbox-design"
  }),
  Object.freeze({
    assetId: "architecture-live-map",
    classification: "developer-documentation",
    paths: Object.freeze(["packages/foundation/src/observability/architecture-live-map.ts"]),
    purpose: "Production-readiness projection over selected architecture nodes and gates.",
    factAuthority: "production-readiness-projection-not-hydration-authority"
  })
]);

export const SYSTEM_ARCHITECTURE_LAYERS: readonly any[] = Object.freeze([
  Object.freeze({
    layerId: "appearance",
    moduleCategory: "appearance",
    label: "外观层",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze([
      "控制面板展示网关、工作空间、审批和系统管理界面",
      "只通过应用层或切面层入口调用能力"
    ])
  }),
  Object.freeze({
    layerId: "platform-capabilities",
    moduleCategory: "core-capability",
    label: "平台能力",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze([
      "汇聚平台能力、通信服务、协作治理、智能体运行能力和策略管理",
      "承载角色配置、认证管理和能力层装配边界"
    ])
  }),
  Object.freeze({
    layerId: "application",
    moduleCategory: "application",
    label: "应用层",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze([
      "网关治理、共享空间、代码管理和通用工具",
      "剥离后失去对应独立应用能力"
    ])
  }),
  Object.freeze({
    layerId: "aspect",
    moduleCategory: "aspect",
    label: "切面层",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze([
      "下游客户端、平台应用服务的协议切面",
      "协议适配、请求归一化、能力投影和 route intent"
    ])
  }),
  Object.freeze({
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "基建层",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze([
      "安全权限、模块管理、装配能力、数据结构、操作证明、环境兼容性、资源管理和运维基础",
      "平台运行和模块脱水机制的不可剥离底座"
    ])
  })
]);
