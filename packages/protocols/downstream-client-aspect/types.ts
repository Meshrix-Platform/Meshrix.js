export type UnknownRecord = Record<string, unknown>;

export interface DownstreamMcpDefinition {
  adapterId: string;
  profileId: string;
  installMode: string;
  locations: readonly string[];
  configurationStrategy: string;
  serverName: string;
  commandNames: readonly string[];
  metadata: { public: UnknownRecord };
}

export interface DownstreamFrameworkDefinition {
  frameworkId: string;
  label: string;
  kind: string;
  commandNames: readonly string[];
  mcp: DownstreamMcpDefinition;
}

export interface DownstreamAssemblyContext {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  localBinDirs?: readonly string[];
  includeDefaultLocalBin?: boolean;
  sequence?: number;
  assembledAt?: string;
}

export interface DownstreamCapability extends UnknownRecord {
  layerId: string;
  protocol: string;
  frameworkId: string;
  frameworkLabel: string;
  status: string;
  adapterId?: string;
  profileId?: string;
}

export interface DownstreamAspectLayer {
  layerId: string;
  adapterKind: string;
  supports(framework: DownstreamFrameworkDefinition): boolean;
  assembleFramework(framework: DownstreamFrameworkDefinition, context?: DownstreamAssemblyContext): DownstreamCapability;
}

export interface DownstreamAspectServicePort {
  listCapabilities(options?: { protocol?: string; frameworkId?: string; includeUnavailable?: boolean }): DownstreamCapability[];
}
