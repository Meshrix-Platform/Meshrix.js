import type {
  TypedServiceReference,
  UpstreamServiceDescriptor
} from "../../../lib/upstream-service-publish-client";

export type PublishDescriptorForm = Omit<UpstreamServiceDescriptor, "serviceProtocol"> & {
  serviceKey: string;
  serviceProtocol?: UpstreamServiceDescriptor["serviceProtocol"] | "";
  operationKey?: string;
  method?: string;
  path?: string;
  risk?: string;
  requestRepresentationMode?: "structured_json" | "opaque_stream" | "artifact_body" | "artifact_multipart" | "";
  responseRepresentationMode?: "structured_json" | "opaque_stream" | "artifact" | "";
  requestMaxBytes?: number | "";
  responseMaxBytes?: number | "";
  requestMediaTypes?: string;
  responseMediaTypes?: string;
  referenceType?: TypedServiceReference["type"] | "";
  referenceValue?: string;
  referenceRevision?: number | "";
  referenceUse?: string;
};

export const descriptorObjectFields = [
  "interfaceSchemas",
  "permissions",
  "approvalPolicy",
  "trafficPolicy",
  "audience",
  "tagPolicy",
  "circuitBreaker"
] as const;
