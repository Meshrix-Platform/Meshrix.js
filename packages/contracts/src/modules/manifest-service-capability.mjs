export const SERVICE_CAPABILITY_LAYERS = Object.freeze([
  Object.freeze({
    layerNumber: 1,
    layerId: "client-types",
    label: "客户端类型",
    functionItems: Object.freeze(["Agent Harness", "Meshrix Client"])
  }),
  Object.freeze({
    layerNumber: 2,
    layerId: "mcp-plugin-capabilities",
    label: "MCP 插件能力层",
    functionItems: Object.freeze(["Discovery", "Gateway", "Verified Plugin Contributions", "External Protocol Adapters"])
  }),
  Object.freeze({
    layerNumber: 3,
    layerId: "operation-routing",
    label: "统一操作路由层",
    functionItems: Object.freeze(["Operation Router", "Policy Router", "Capability Router"])
  }),
  Object.freeze({
    layerNumber: 4,
    layerId: "cache-algorithm-foundation",
    label: "缓存与算法底座层",
    functionItems: Object.freeze(["LSM Ingest Pipeline", "CAS Block Store", "Merkle DAG Manifests", "Prefix / Range Index", "State Commit / Projection"])
  }),
  Object.freeze({
    layerNumber: 5,
    layerId: "gateways",
    label: "网关层",
    functionItems: Object.freeze(["Operation Gateway", "Service Gateway", "Block Sync Gateway", "Secret And Connection Gateway"])
  }),
  Object.freeze({
    layerNumber: 6,
    layerId: "external-applications",
    label: "外部应用",
    functionItems: Object.freeze(["Operator-configured upstream APIs"])
  })
]);
export const SERVICE_CAPABILITY_PROTOCOL_FIELDS = Object.freeze([
  Object.freeze({
    fieldId: "meshrix.call",
    layerNumber: 3,
    label: "meshrix.call",
    functionItems: Object.freeze(["统一操作调用入口", "HTTP / RPC / CLI 的等价调用面"])
  }),
  Object.freeze({
    fieldId: "operationId",
    layerNumber: 3,
    label: "operationId",
    functionItems: Object.freeze(["Operation Router 解析的操作标识", "关联 subject、workspace 和 params"])
  })
]);
