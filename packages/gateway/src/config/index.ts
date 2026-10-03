import type { CredentialProvider } from "@meshrix/contracts/gateway";

export interface ServiceCustomFieldDescriptor {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "json";
  readonly location: "header" | "query" | "body";
  readonly required?: boolean;
  readonly affectsAuthorization?: boolean;
}

export interface GatewayServiceConfig {
  readonly serviceId: string;
  readonly baseUrl: string;
  readonly method: string;
  readonly customFields?: Readonly<Record<string, unknown>>;
  readonly customFieldDescriptors?: readonly ServiceCustomFieldDescriptor[];
  readonly credentialBinding?: string;
  readonly allowedMethods?: readonly string[];
  readonly egressPolicy?: Readonly<Record<string, unknown>>;
}

export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw Object.assign(new Error("Service base URL is required."), { code: "service_url_invalid", status: 400 });
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw Object.assign(new Error("Service base URL is invalid."), { code: "service_url_invalid", status: 400 }); }
  if (!(["http:", "https:"].includes(url.protocol))) throw Object.assign(new Error("Service base URL must use HTTP or HTTPS."), { code: "service_url_invalid", status: 400 });
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

export function normalizeMethod(value: unknown): string {
  if (typeof value !== "string") throw Object.assign(new Error("Service method is required."), { code: "service_method_invalid", status: 400 });
  const method = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9-]*$/u.test(method)) throw Object.assign(new Error("Service method is invalid."), { code: "service_method_invalid", status: 400 });
  return method;
}

function validateCustomFields(config: GatewayServiceConfig): void {
  const values = config.customFields ?? {};
  const descriptors = config.customFieldDescriptors ?? [];
  const allowed = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  for (const [name, value] of Object.entries(values)) {
    const descriptor = allowed.get(name);
    if (!descriptor) throw Object.assign(new Error(`Custom field is not declared: ${name}`), { code: "custom_field_undeclared", status: 400 });
    if (descriptor.type === "string" && typeof value !== "string" || descriptor.type === "number" && typeof value !== "number" || descriptor.type === "boolean" && typeof value !== "boolean" || descriptor.type === "json" && value === undefined) {
      throw Object.assign(new Error(`Custom field has the wrong type: ${name}`), { code: "custom_field_invalid", status: 400 });
    }
  }
  for (const descriptor of descriptors) {
    if (descriptor.required && !Object.hasOwn(values, descriptor.name)) throw Object.assign(new Error(`Required custom field is missing: ${descriptor.name}`), { code: "custom_field_required", status: 400 });
  }
}

export function normalizeServiceConfig(input: Omit<GatewayServiceConfig, "baseUrl" | "method"> & { readonly baseUrl: unknown; readonly method?: unknown }): GatewayServiceConfig {
  const config = Object.freeze({
    ...input,
    serviceId: String(input.serviceId ?? "").trim(),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    method: normalizeMethod(input.method ?? "POST"),
    allowedMethods: Object.freeze((input.allowedMethods ?? [input.method ?? "POST"]).map((method) => normalizeMethod(method)))
  });
  if (!config.serviceId) throw Object.assign(new Error("Service id is required."), { code: "service_id_invalid", status: 400 });
  validateCustomFields(config);
  return config;
}

export function customFieldsForRequest(config: GatewayServiceConfig, fields: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  const descriptors = new Map((config.customFieldDescriptors ?? []).map((descriptor) => [descriptor.name, descriptor]));
  const output: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    const descriptor = descriptors.get(name);
    if (!descriptor) throw Object.assign(new Error(`Custom field is not declared: ${name}`), { code: "custom_field_undeclared", status: 400 });
    output[name] = value;
  }
  return Object.freeze(output);
}

export interface CustomFieldProjection {
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Applies only declared fields to their declared request locations. */
export function projectCustomFields(config: GatewayServiceConfig, fields: Readonly<Record<string, unknown>> = {}): CustomFieldProjection {
  const declared = customFieldsForRequest(config, fields);
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  const descriptors = new Map((config.customFieldDescriptors ?? []).map((descriptor) => [descriptor.name, descriptor]));
  for (const [name, value] of Object.entries(declared)) {
    const descriptor = descriptors.get(name);
    if (!descriptor) continue;
    if (descriptor.location === "header") headers[name] = String(value);
    else if (descriptor.location === "query") query[name] = String(value);
    else body[name] = value;
  }
  return Object.freeze({ headers: Object.freeze(headers), query: Object.freeze(query), body: Object.freeze(body) });
}

export function createCredentialProvider(resolver: (binding: string, audience: string) => Promise<unknown>): CredentialProvider {
  return Object.freeze({
    async resolve({ binding, audience }: { readonly binding: string; readonly audience: string }): Promise<unknown> {
      if (!binding || !audience) throw Object.assign(new Error("Credential binding and audience are required."), { code: "credential_binding_invalid", status: 403 });
      return resolver(binding, audience);
    }
  });
}
