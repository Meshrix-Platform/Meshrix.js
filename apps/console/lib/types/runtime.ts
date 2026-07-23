import type { ConsoleAuthSummary } from "../auth-types";

export type AnalysisModuleInfo = {
  id: string;
  label: string;
  description: string;
  executionMode: string;
};

export type ClientAlignmentState =
  | "aligned"
  | "outdated"
  | "draining"
  | "bootstrap-only"
  | "offline"
  | "unknown";

export type DiscoveryClientSummary = {
  totalCount: number;
  alignedCount: number;
  outdatedCount: number;
  drainingCount: number;
  bootstrapOnlyCount: number;
  offlineCount: number;
  unknownCount: number;
  licoClientCount?: number;
  mcpPluginCount?: number;
  alignableCount?: number;
};

export type ClientConnectionKind = "lico-client" | "mcp-plugin" | string;

export type DiscoveryClientRegistration = {
  clientId: string;
  clientLabel: string;
  appVersion: string;
  platform: string;
  hostname: string;
  bootstrapUrl: string;
  currentServiceUrl: string;
  desiredServiceUrl: string;
  currentJobServiceUrl: string;
  configVersion: string;
  alignmentState: ClientAlignmentState;
  connectionKind?: ClientConnectionKind;
  connectionMethod?: string;
  connectionState?: string;
  connectionStatusLabel?: string;
  connectionDetail?: string;
  supportsAlignment?: boolean;
  sourceGrantId?: string;
  busy: boolean;
  lastJobId: string;
  lastError: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSeenServerId: string;
};

export type DiscoveryClientsResponse = {
  summary: DiscoveryClientSummary;
  items: DiscoveryClientRegistration[];
};

export type DiscoveryConfig = {
  serverId: string;
  serverLabel: string;
  bootstrapBaseUrl: string;
  advertisedBaseUrl: string;
  activeServiceUrl: string;
  forwardBaseUrl: string;
  mode: "" | "active" | "forward";
  configVersion: string;
  refreshIntervalSeconds: number;
  checkInIntervalSeconds: number;
  offlineAfterSeconds: number;
};

export type DiscoveryConfigResponse = {
  value: DiscoveryConfig;
  bootstrap: {
    ok: boolean;
    serverId: string;
    serverLabel: string;
    bootstrapBaseUrl: string;
    advertisedBaseUrl: string;
    activeServiceUrl: string;
    forwardBaseUrl: string;
    mode: "active" | "forward";
    configVersion: string;
    refreshIntervalSeconds: number;
    checkInIntervalSeconds: number;
    offlineAfterSeconds: number;
    alignmentRequired: boolean;
  };
};

export type RuntimeMountInfo = {
  name: string;
  id: string;
  kind: string;
  enabled: boolean;
  reason: string;
  supportsStructuredDocument: boolean;
  supportsTextExtraction: boolean;
  supportsBatchHook: boolean;
};

export type RuntimeArchitectureLayer = {
  layerId: string;
  moduleCategory: string;
  label: string;
  hydration: "essential" | "optional" | string;
  hydratable: boolean;
  functionItems: string[];
};

export type RuntimeArchitectureModuleCategory = {
  categoryId: string;
  label: string;
  description: string;
};

export type RuntimeArchitectureComponent = {
  componentId: string;
  moduleId: string;
  parentModuleId?: string;
  featureId?: string;
  pluginId?: string;
  label: string;
  layerId: string;
  moduleCategory: "foundation" | "core-capability" | "application" | "aspect" | "appearance" | string;
  hydration: "essential" | "optional" | string;
  hydratable: boolean;
  functionItems: string[];
};

export type RuntimeArchitectureComponentInventory = {
  protocolVersion: string;
  source: string;
  layers?: RuntimeArchitectureLayer[];
  moduleCategoryDefinitions?: RuntimeArchitectureModuleCategory[];
  baseComponents: RuntimeArchitectureComponent[];
  foundationComponents: RuntimeArchitectureComponent[];
  hydratableBaseComponents: RuntimeArchitectureComponent[];
  nonHydratableBaseComponents: RuntimeArchitectureComponent[];
  hydratableComponents: RuntimeArchitectureComponent[];
  nonHydratableComponents: RuntimeArchitectureComponent[];
  componentsByCategory: Record<string, RuntimeArchitectureComponent[]>;
  allComponents: RuntimeArchitectureComponent[];
};

export type MountRouteTarget = {
  mountName: string;
  action: string;
};

export type MountRoutingConfig = {
  kindRoutes: Record<string, MountRouteTarget>;
  extensionRoutes: Record<string, MountRouteTarget>;
  mediaTypeRoutes: Record<string, MountRouteTarget>;
};

export type RuntimeMountConfig = {
  mountModules: Record<string, string | {
    id?: string;
    kind?: string;
    modulePath?: string;
    path?: string;
    pluginId?: string;
    provider?: string;
    enabled?: boolean;
    options?: Record<string, unknown>;
  }>;
  mountRouting: MountRoutingConfig;
};

export type RuntimeInfoResponse = {
  server: {
    url: string;
    userDataPath: string;
    distPath: string;
    hostname: string;
  };
  runtime: {
    profile: string;
    cwd: string;
    mountModules: RuntimeMountConfig["mountModules"];
    mountRouting: MountRoutingConfig;
    mountGeneration: number;
    mountConfigPath?: string;
    mountConfigPaths?: {
      modulesPath: string;
      routingPath: string;
    };
    mountConfig?: RuntimeMountConfig;
    mounts: RuntimeMountInfo[];
    architectureComponents?: RuntimeArchitectureComponentInventory;
  };
  storage: {
    databaseExists?: boolean;
    objectCount: number;
    ownedObjectCount?: number;
    deletionOperationCount?: number;
    objectFileCount?: number;
    objectBytes?: number;
  };
  discovery: DiscoveryConfigResponse["bootstrap"];
  auth?: ConsoleAuthSummary | null;
  features?: FeatureRuntimeSummary | null;
};

export type RuntimeAssemblyBuildPayload = {
  selectedComponentIds: string[];
};

export type RuntimeAssemblyArtifact = {
  artifactId: string;
  artifactRef: string;
  fileName: string;
  byteSize: number;
  createdAt: string;
  componentCount: number;
  requiredComponentCount: number;
  omittedComponentCount: number;
  portableDirectoryName?: string;
  portableManifestFileName?: string;
  portablePackageMetadataFileName?: string;
  portableChecksumFileName?: string;
  portablePackageFileCount?: number;
  portablePackageByteSize?: number;
  portablePackageSha256?: string;
};

export type RuntimeAssemblyBuildResponse = {
  schemaVersion: string;
  protocolVersion: string;
  ok: boolean;
  artifact: RuntimeAssemblyArtifact;
  selection: {
    requestedComponentIds: string[];
    includedComponentIds: string[];
    requiredComponentIds: string[];
    omittedComponentIds: string[];
    unknownRequestedComponentIds: string[];
  };
  summary: {
    componentCount: number;
    hydratableComponentCount: number;
    requiredComponentCount: number;
    omittedComponentCount: number;
    runtimeProfile: string;
    featureCount: number;
    mountCount: number;
  };
};

export type FeatureRuntimeSummary = {
  schemaVersion: string;
  edition: string;
  profileName?: string;
  generatedAt?: string;
  activeFeatureIds: string[];
  disabledFeatureIds: string[];
  activeFeatures?: Array<{
    featureId: string;
    label: string;
    group: string;
    required?: boolean;
    reason?: string;
  }>;
  disabledFeatures?: Array<{
    featureId: string;
    label: string;
    group: string;
    required?: boolean;
    reason?: string;
  }>;
  operations?: {
    total: number;
    active: number;
    disabled: number;
  };
  plugins?: {
    loadedPlugins: Array<{
      id: string;
      version: string;
      features: string[];
    }>;
    effectivePlugins: Array<{ id: string; version: string; features: string[] }>;
    consoleEntries: Array<{
      id: string;
      pluginId: string;
      featureId: string;
      viewKey: string;
      routePath?: string;
      slotId?: string;
      componentId: string;
      assetUrl: string;
      assetExport: string;
      artifactDigest: string;
      artifactGeneration: number;
      label?: string;
      requiredScopes: string[];
    }>;
  };
};

export type RuntimeMountsResponse = {
  path: string;
  paths: {
    modulesPath: string;
    routingPath: string;
  };
  value: RuntimeMountConfig;
  runtime: Pick<
    RuntimeInfoResponse["runtime"],
    "mountGeneration" | "mountModules" | "mountRouting"
  > & {
    mounts?: RuntimeMountInfo[];
  };
};

export type ServerPathBrowseEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "other" | string;
  byteSize: number;
  modifiedAt: string;
  hidden: boolean;
  selectable: boolean;
  browsable: boolean;
};

export type ServerPathBrowseResponse = {
  currentPath: string;
  parentPath: string;
  mode: "directory" | "file" | string;
  extensions: string[];
  roots: Array<{ label: string; path: string }>;
  entries: ServerPathBrowseEntry[];
  truncated: boolean;
  error?: string;
};

export type RuntimeMountReloadResponse = {
  ok: boolean;
  mountGeneration: number;
  mountModules: RuntimeMountConfig["mountModules"];
  mountRouting: MountRoutingConfig;
};
