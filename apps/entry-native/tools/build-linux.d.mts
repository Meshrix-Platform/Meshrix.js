export interface PublicDependency {
  name: string;
  version: string;
  source: string;
}

export interface CargoMetadata {
  packages: Array<{ name: string; version: string; source: string | null }>;
}

export interface HostBuildResult {
  destination: string;
  manifest: Record<string, unknown>;
}

export interface HostBuildOptions {
  workspace?: string;
  platform?: string;
  arch?: string;
  environment?: Record<string, string | undefined>;
  execute?: (command: string, args: string[], options?: Record<string, unknown>) => Promise<void>;
  inspect?: (command: string, args: string[], options?: Record<string, unknown>) => Promise<string>;
}

export function fetchCommand(jobs: number): string;
export function builderCommand(jobs: number, hostArch: string): string;
export function stageWorkspace(stageDir: string, pathspec?: string[], rootDir?: string): Promise<void>;
export function nativeHostTarget(rustcDetails: string, platform?: string, arch?: string): string;
export function publicDependencyEvidence(metadata: CargoMetadata): PublicDependency[];
export function validatePublicBuildProvenance(manifest: { lockSha256?: unknown; dependencies?: unknown } | null | undefined, expected?: { lockSha256?: string; dependencies?: PublicDependency[] }): PublicDependency[];
export function validateToolchainMount(dir: string, label?: string, home?: string): string;
export function buildNativeHost(options?: HostBuildOptions): Promise<HostBuildResult>;
