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

export class DownstreamClientAspectService {
  assemblies: any;
  cwd: any;
  env: any;
  frameworks: any;
  includeDefaultLocalBin: any;
  layers: any;
  localBinDirs: any;
  logger: any;
  serviceId: any;
  started: any;
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
  }: Record<string, any> = {}) {
    this.serviceId = serviceId;
    this.frameworks = (frameworks || defaultDownstreamClientFrameworks(frameworkOverrides))
      .map(normalizeFrameworkDefinition);
    this.layers = layers || createDefaultDownstreamClientAspectLayers();
    this.env = env;
    this.cwd = cwd;
    this.localBinDirs = localBinDirs;
    this.includeDefaultLocalBin = includeDefaultLocalBin !== false;
    this.logger = logger;
    this.started = false;
    this.assemblies = [];
  }

  listProtocolLayers() : any {
    return this.layers.map((layer?: any) : any => Object.freeze({
      layerId: layer.layerId,
      adapterKind: layer.adapterKind
    }));
  }

  start({ now = new Date() }: Record<string, any> = {}) : any {
    const assembledAt: any = now.toISOString();
    const assemblies: any[] = [];
    let sequence: any = 0;
    for (const framework of this.frameworks) {
      for (const layer of this.layers) {
        sequence += 1;
        const record: any = layer.assembleFramework(framework, {
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

  listCapabilities({ protocol = "", frameworkId = "", includeUnavailable = true }: Record<string, any> = {}) : any {
    const protocolFilter: any = lowerToken(protocol);
    const frameworkFilter: any = lowerToken(frameworkId);
    return this.assemblies.filter((record?: any) : any => {
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

  translateInboundRequest(request: Record<string, any> = {}) : any {
    return translateDownstreamClientInboundRequest(this, request);
  }

  summary() : any {
    const byProtocol: Record<string, any> = {};
    const byStatus: Record<string, any> = {};
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

  stop() : any {
    this.started = false;
    return {
      ok: true,
      serviceId: this.serviceId,
      stopped: true
    };
  }
}

export function createDownstreamClientAspectService(options: Record<string, any> = {}) : any {
  return new DownstreamClientAspectService(options);
}

export function assembleDownstreamClientAspect(options: Record<string, any> = {}) : any {
  const service: any = createDownstreamClientAspectService(options);
  const summary: any = service.start(options.start || {});
  return {
    service,
    summary,
    capabilities: service.listCapabilities()
  };
}
