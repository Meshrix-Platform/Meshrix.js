import {
  DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION,
  DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND
} from "./constants.ts";
import type { DownstreamFrameworkDefinition, DownstreamMcpDefinition } from "./types.ts";

export function protocolRecordBase({ layerId, framework, protocolConfig, sequence = 0, assembledAt = "" }: {
  layerId: string;
  framework: DownstreamFrameworkDefinition;
  protocolConfig: DownstreamMcpDefinition;
  sequence?: number;
  assembledAt?: string;
}) {
  return Object.freeze({
    aspectProtocolVersion: DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION,
    serviceKind: DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND,
    layerId,
    protocol: layerId,
    frameworkId: framework.frameworkId,
    frameworkLabel: framework.label,
    frameworkKind: framework.kind,
    adapterId: protocolConfig.adapterId,
    profileId: protocolConfig.profileId,
    startup: Object.freeze({ sequence, assembledAt })
  });
}
