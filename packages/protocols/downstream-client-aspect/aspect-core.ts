import {
  DEFAULT_PRIORITY_FRAMEWORKS,
  DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION,
  DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS,
  DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND
} from "./constants.ts";
import { createDefaultDownstreamClientAspectLayers } from "./aspect-layers.ts";
import {
  defaultDownstreamClientFrameworks,
  normalizeFrameworkDefinition
} from "./client-registry.ts";
import { lowerToken } from "./identity-helpers.ts";
import { translateDownstreamClientInboundRequest } from "./request-helpers.ts";
import type {
  DownstreamAspectLayer,
  DownstreamCapability,
  DownstreamFrameworkDefinition,
  UnknownRecord
} from "./types.ts";

interface AspectLogger {
  info(message: string, facts: UnknownRecord): void;
}

export interface DownstreamClientAspectOptions {
  serviceId?: string;
  frameworks?: readonly unknown[] | null;
  frameworkOverrides?: readonly unknown[];
  layers?: DownstreamAspectLayer[] | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  localBinDirs?: readonly string[];
  includeDefaultLocalBin?: boolean;
  logger?: AspectLogger | null;
  start?: { now?: Date };
}

export class DownstreamClientAspectService {
  assemblies: DownstreamCapability[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  frameworks: DownstreamFrameworkDefinition[];
  includeDefaultLocalBin: boolean;
  layers: DownstreamAspectLayer[];
  localBinDirs: readonly string[];
  logger: AspectLogger | null;
  serviceId: string;
  started: boolean;
  constructor({
    serviceId = "meshrix.downstream-client-aspect",
    frameworks = null,
    frameworkOverrides = [],
    layers = null,
    env = process.env,
    cwd = process.cwd(),
    localBinDirs = [],
    includeDefaultLocalBin = true,
    logger = null
  }: DownstreamClientAspectOptions = {}) {
    this.serviceId = serviceId;
    this.frameworks = (frameworks || defaultDownstreamClientFrameworks(frameworkOverrides))
      .map((entry) => normalizeFrameworkDefinition(
        entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry } : {}
      ));
    this.layers = layers || createDefaultDownstreamClientAspectLayers();
    this.env = env;
    this.cwd = cwd;
    this.localBinDirs = localBinDirs;
    this.includeDefaultLocalBin = includeDefaultLocalBin !== false;
    this.logger = logger;
    this.started = false;
    this.assemblies = [];
  }

  listProtocolLayers() {
    return this.layers.map((layer) => Object.freeze({
      layerId: layer.layerId,
      adapterKind: layer.adapterKind
    }));
  }

  start({ now = new Date() }: { now?: Date } = {}) {
    const assembledAt = now.toISOString();
    const assemblies: DownstreamCapability[] = [];
    let sequence = 0;
    for (const framework of this.frameworks) {
      for (const layer of this.layers) {
        sequence += 1;
        const record = layer.assembleFramework(framework, {
          env: this.env,
          cwd: this.cwd,
          localBinDirs: this.localBinDirs,
          includeDefaultLocalBin: this.includeDefaultLocalBin,
          sequence,
          assembledAt
        });
        assemblies.push(record);
      }
    }
    this.assemblies = assemblies;
    this.started = true;
    if (this.logger && typeof this.logger.info === "function") {
      this.logger.info("Downstream client aspect assembled protocol adapters.", {
        serviceId: this.serviceId,
        frameworkCount: this.frameworks.length,
        layerCount: this.layers.length,
        assemblyCount: assemblies.length
      });
    }
    return this.summary();
  }

  listCapabilities({ protocol = "", frameworkId = "", includeUnavailable = true }: { protocol?: string; frameworkId?: string; includeUnavailable?: boolean } = {}): DownstreamCapability[] {
    const protocolFilter = lowerToken(protocol);
    const frameworkFilter = lowerToken(frameworkId);
    return this.assemblies.filter((record) => {
      if (!includeUnavailable && record.status === "unavailable") {
        return false;
      }
      if (protocolFilter && record.protocol !== protocolFilter) {
        return false;
      }
      if (frameworkFilter && record.frameworkId !== frameworkFilter) {
        return false;
      }
      return true;
    });
  }

  translateInboundRequest(request: UnknownRecord = {}) {
    return translateDownstreamClientInboundRequest(this, request);
  }

  summary() {
    const byProtocol: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const record of this.assemblies) {
      byProtocol[record.protocol] = (byProtocol[record.protocol] || 0) + 1;
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
    }
    return Object.freeze({
      ok: true,
      serviceId: this.serviceId,
      protocolVersion: DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION,
      serviceKind: DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND,
      started: this.started,
      frameworkCount: this.frameworks.length,
      layerCount: this.layers.length,
      assemblyCount: this.assemblies.length,
      priorityFrameworks: [...DEFAULT_PRIORITY_FRAMEWORKS],
      byProtocol,
      byStatus,
      routeTargets: { ...DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS },
      layers: this.listProtocolLayers()
    });
  }

  stop() {
    this.started = false;
    return {
      ok: true,
      serviceId: this.serviceId,
      stopped: true
    };
  }
}

export function createDownstreamClientAspectService(options: DownstreamClientAspectOptions = {}): DownstreamClientAspectService {
  return new DownstreamClientAspectService(options);
}

export function assembleDownstreamClientAspect(options: DownstreamClientAspectOptions = {}) {
  const service = createDownstreamClientAspectService(options);
  const summary = service.start(options.start || {});
  return {
    service,
    summary,
    capabilities: service.listCapabilities()
  };
}
