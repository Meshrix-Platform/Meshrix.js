import type { AuthenticatedContext, CredentialProvider } from "@meshrix/contracts/gateway";

export interface GatewayCredentialResolver {
  resolve(input: { readonly binding: string; readonly audience: string; readonly context: AuthenticatedContext }): Promise<unknown>;
}

export interface GatewayCredentialProviderOptions {
  readonly allowedAudiences?: readonly string[];
}

/**
 * Credential resolution remains an injected capability. The provider checks
 * the audience before asking the operator-owned resolver for material.
 */
export class GatewayCredentialProvider implements CredentialProvider {
  readonly #resolver: GatewayCredentialResolver;
  readonly #allowedAudiences?: ReadonlySet<string>;

  constructor(resolver: GatewayCredentialResolver, options: GatewayCredentialProviderOptions = {}) {
    this.#resolver = resolver;
    this.#allowedAudiences = options.allowedAudiences ? new Set(options.allowedAudiences) : undefined;
  }

  resolve(input: { readonly binding: string; readonly audience: string; readonly context: AuthenticatedContext }): Promise<unknown> {
    if (!input.binding || !input.audience || this.#allowedAudiences && !this.#allowedAudiences.has(input.audience)) {
      return Promise.reject(Object.assign(new Error("Credential binding is not authorized for this audience."), { code: "credential_audience_denied", status: 403 }));
    }
    return this.#resolver.resolve(input);
  }
}

export function createGatewayCredentialProvider(resolver: GatewayCredentialResolver, options: GatewayCredentialProviderOptions = {}): GatewayCredentialProvider {
  return new GatewayCredentialProvider(resolver, options);
}
