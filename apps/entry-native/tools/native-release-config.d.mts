export interface NativeTarget {
  component: string;
  arch: string;
  rustTarget: string;
  buildTarget: string;
  packageName: string;
  binaryName: string;
  libc: string;
  binaryPath: string;
  archiveProduct: string;
  archiveBinary: string;
}

export interface LinuxBuilderProfile {
  platform: string;
  imageTag: string;
  base: string;
  protocPackage: string;
  protocSha256: string;
}

export interface NativeReleaseConfig {
  schemaVersion: string;
  targets: { linux: NativeTarget[]; macos: NativeTarget[] };
  linuxBuilders: { aarch64: LinuxBuilderProfile; x86_64: LinuxBuilderProfile };
  runtimeImages: Record<string, { aarch64: string; x86_64: string }>;
  macosProtoc: { version: string; url: string; sha256: string };
}

export function loadNativeReleaseConfig(): NativeReleaseConfig;
export function nativeTargets(platform: "linux" | "macos"): readonly NativeTarget[];
