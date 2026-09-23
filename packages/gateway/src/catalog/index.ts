import type {
  AuthenticatedContext,
  CatalogDescriptor,
  CatalogPage,
  CatalogPort,
  CatalogQuery,
  RouteSnapshot
} from "@meshrix/contracts/gateway";
import { canonicalJson, cloneJson, deepFreeze, digest, isPlainRecord } from "../utils.ts";
import { createIsolatedSchemaValidator, createSchemaValidator, type CompiledExternalSchema, type IsolatedExternalSchema, type IsolatedSchemaValidator } from "../schema/index.ts";

export interface CatalogSchemaValidators {
  readonly input?: CompiledExternalSchema | IsolatedExternalSchema;
  readonly output?: CompiledExternalSchema | IsolatedExternalSchema;
}

export interface CatalogSnapshot {
  readonly revision: string;
  readonly descriptors: readonly CatalogDescriptor[];
  readonly routes: ReadonlyMap<string, RouteSnapshot>;
  readonly schemas: ReadonlyMap<string, CatalogSchemaValidators>;
  readonly byRoute: ReadonlyMap<string, CatalogDescriptor>;
  readonly byPublicName: ReadonlyMap<string, CatalogDescriptor>;
  readonly byPublicUri: ReadonlyMap<string, CatalogDescriptor>;
}

function cursorError(code: string, message: string): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status: 409 });
}

function partitionKey(context: AuthenticatedContext): string {
  return digest({ tenant: context.tenant, principal: context.principal, grant: context.grant });
}

function queryKey(query: CatalogQuery): string {
  return canonicalJson({ kind: query.kind ?? null, search: query.search ?? "", limit: query.limit ?? 0 });
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isPlainRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw cursorError("catalog_cursor_invalid", "Catalog cursor is invalid.");
  }
}

export function createStableAlias(kind: CatalogDescriptor["kind"], upstreamIdentity: string, upstreamName: string, digestLength = 12): string {
  const safe = upstreamName.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80) || "item";
  return `mx_${kind}_${safe}_${digest({ upstreamIdentity, upstreamName }).slice(0, digestLength)}`;
}

function normalizeDescriptor(descriptor: CatalogDescriptor, usedNames: Set<string>): CatalogDescriptor {
  const route = deepFreeze(cloneJson(descriptor.route));
  const baseName = descriptor.publicName ?? (descriptor.upstreamName ? createStableAlias(descriptor.kind, `${route.upstreamIdentity}:${route.logicalRoute}`, descriptor.upstreamName) : undefined);
  const templateVariables = descriptor.kind === "resource_template" && descriptor.upstreamUri
    ? [...descriptor.upstreamUri.matchAll(/\{\+?[A-Za-z][A-Za-z0-9_]*\}/gu)].map((match) => match[0]) : [];
  const baseUri = descriptor.publicUri ?? (descriptor.upstreamUri
    ? descriptor.kind === "resource_template"
      ? `meshrix://${digest(route.upstreamIdentity).slice(0, 12)}/${digest(descriptor.upstreamUri).slice(0, 20)}${templateVariables.map((value) => `/${value}`).join("")}`
      : `meshrix://${route.upstreamIdentity}/${digest(descriptor.upstreamUri).slice(0, 20)}`
    : undefined);
  const publicName = baseName;
  if (publicName && usedNames.has(`${descriptor.kind}:${publicName}`)) throw cursorError("catalog_name_conflict", "Public catalog name is ambiguous.");
  if (publicName) usedNames.add(`${descriptor.kind}:${publicName}`);
  const normalized: CatalogDescriptor = {
    ...cloneJson(descriptor),
    route,
    ...(publicName === undefined ? {} : { publicName }),
    ...(baseUri === undefined ? {} : { publicUri: baseUri }),
    ...(descriptor.metadata === undefined ? {} : { metadata: deepFreeze(cloneJson(descriptor.metadata)) }),
    ...(descriptor.annotations === undefined ? {} : { annotations: deepFreeze(cloneJson(descriptor.annotations)) })
  };
  return deepFreeze(normalized);
}

function readOnlyMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  const readonly = {
    get: (key: K) => map.get(key),
    has: (key: K) => map.has(key),
    get size() { return map.size; },
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void) => map.forEach((value, key) => callback(value, key, readonly as ReadonlyMap<K, V>)),
    [Symbol.iterator]: () => map[Symbol.iterator]()
  } as ReadonlyMap<K, V>;
  return Object.freeze(readonly);
}

function visibleToContext(descriptor: CatalogDescriptor, context: AuthenticatedContext): boolean {
  if (context.grant.revoked === true) return false;
  const selections = ["routes", "routeRefs"].filter((key) => Object.hasOwn(context.grant, key));
  return selections.length > 0 && selections.every((key) => {
    const value = context.grant[key];
    return value === "all" || Array.isArray(value) && value.includes(descriptor.route.logicalRoute) ||
      isPlainRecord(value) && (value.mode === "all" || value.mode === "only" && Array.isArray(value.items) && value.items.includes(descriptor.route.logicalRoute));
  });
}

export class CatalogStore implements CatalogPort {
  readonly #schemaValidator = createSchemaValidator();
  readonly #isolated?: IsolatedSchemaValidator;
  #snapshot: CatalogSnapshot = Object.freeze({ revision: "r0", descriptors: Object.freeze([]), routes: readOnlyMap(new Map()), schemas: readOnlyMap(new Map()), byRoute: readOnlyMap(new Map()), byPublicName: readOnlyMap(new Map()), byPublicUri: readOnlyMap(new Map()) });

  constructor(options: { readonly isolated?: boolean } = {}) {
    this.#isolated = options.isolated ? createIsolatedSchemaValidator() : undefined;
  }

  async preflightSchema(schema: unknown, signal?: AbortSignal): Promise<void> {
    if (this.#isolated) await this.#isolated.preflight(schema, signal);
    else this.#schemaValidator.compile(schema);
  }

  async close(): Promise<void> { await this.#isolated?.close(); }

  retentionStats(): Readonly<{ descriptors: number; routes: number; publicNames: number; publicUris: number; schemaWorkers: Readonly<{ workers: number; active: number; queued: number; deadlineTimers: number }> }> {
    return Object.freeze({ descriptors: this.#snapshot.descriptors.length, routes: this.#snapshot.byRoute.size,
      publicNames: this.#snapshot.byPublicName.size, publicUris: this.#snapshot.byPublicUri.size,
      schemaWorkers: this.#isolated?.stats() ?? { workers: 0, active: 0, queued: 0, deadlineTimers: 0 } });
  }

  publish(descriptors: readonly CatalogDescriptor[]): string {
    const usedNames = new Set<string>();
    const counts = new Map<string, number>();
    for (const descriptor of descriptors) {
      if (!descriptor.publicName) continue;
      const key = `${descriptor.kind}:${descriptor.publicName}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const normalized = descriptors.map((descriptor) => normalizeDescriptor(
      descriptor.publicName && (counts.get(`${descriptor.kind}:${descriptor.publicName}`) ?? 0) > 1
        ? { ...descriptor, publicName: `${descriptor.publicName}_${digest(descriptor.route.logicalRoute).slice(0, 16)}` }
        : descriptor,
      usedNames
    ));
    const routes = new Map<string, RouteSnapshot>();
    const schemas = new Map<string, CatalogSchemaValidators>();
    const byRoute = new Map<string, CatalogDescriptor>();
    const byPublicName = new Map<string, CatalogDescriptor>();
    const byPublicUri = new Map<string, CatalogDescriptor>();
    for (const descriptor of normalized) {
      if (byRoute.has(descriptor.route.logicalRoute)) throw cursorError("catalog_route_conflict", "Catalog route identity is ambiguous.");
      byRoute.set(descriptor.route.logicalRoute, descriptor);
      if (descriptor.publicName) byPublicName.set(`${descriptor.kind}:${descriptor.publicName}`, descriptor);
      if (descriptor.publicUri) {
        const key = `${descriptor.kind}:${descriptor.publicUri}`;
        if (byPublicUri.has(key)) throw cursorError("catalog_uri_conflict", "Catalog URI is ambiguous.");
        byPublicUri.set(key, descriptor);
      }
      routes.set(descriptor.route.logicalRoute, descriptor.route);
      const input = descriptor.inputSchema === undefined
        ? undefined
        : this.#isolated?.compile(descriptor.inputSchema) ?? this.#schemaValidator.compile(descriptor.inputSchema, `Input schema for ${descriptor.route.logicalRoute}`);
      const output = descriptor.outputSchema === undefined
        ? undefined
        : this.#isolated?.compile(descriptor.outputSchema) ?? this.#schemaValidator.compile(descriptor.outputSchema, `Output schema for ${descriptor.route.logicalRoute}`);
      if (input || output) schemas.set(descriptor.route.logicalRoute, Object.freeze({ ...(input ? { input } : {}), ...(output ? { output } : {}) }));
    }
    const revision = `r${Number(this.#snapshot.revision.slice(1) || 0) + 1}`;
    this.#snapshot = Object.freeze({
      revision,
      descriptors: Object.freeze(normalized),
      routes: readOnlyMap(routes),
      schemas: readOnlyMap(schemas),
      byRoute: readOnlyMap(byRoute),
      byPublicName: readOnlyMap(byPublicName),
      byPublicUri: readOnlyMap(byPublicUri)
    });
    return revision;
  }

  snapshot(): CatalogSnapshot {
    return this.#snapshot;
  }

  page(context: AuthenticatedContext, query: CatalogQuery = {}): CatalogPage {
    const snapshot = this.#snapshot;
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 50)));
    const key = partitionKey(context);
    const search = query.search?.toLocaleLowerCase() ?? "";
    const filtered = snapshot.descriptors.filter((descriptor) => {
      if (!visibleToContext(descriptor, context)) return false;
      if (query.kind && descriptor.kind !== query.kind) return false;
      if (!search) return true;
      return [descriptor.publicName, descriptor.publicUri, descriptor.description]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(search));
    });
    const revision = digest(filtered.map((descriptor) => ({ kind: descriptor.kind, route: descriptor.route, name: descriptor.publicName, uri: descriptor.publicUri, inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema }))).slice(0, 32);
    let offset = 0;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (cursor.partition !== key || cursor.query !== queryKey(query)) throw cursorError("catalog_cursor_forbidden", "Catalog cursor belongs to another authorization partition.");
      if (cursor.revision !== revision) throw cursorError("catalog_cursor_expired", "Catalog cursor refers to an older snapshot.");
      offset = Number(cursor.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) throw cursorError("catalog_cursor_invalid", "Catalog cursor offset is invalid.");
    }
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length
      ? encodeCursor({ revision, partition: key, query: queryKey(query), offset: nextOffset })
      : undefined;
    return Object.freeze({ revision, items: Object.freeze(items), ...(nextCursor ? { nextCursor } : {}) });
  }

  resolve(routeRef: string): RouteSnapshot | undefined {
    return this.#snapshot.routes.get(routeRef);
  }

  descriptor(routeRef: string): CatalogDescriptor | undefined {
    return this.#snapshot.byRoute.get(routeRef);
  }

  publicDescriptor(context: AuthenticatedContext, kind: CatalogDescriptor["kind"], value: string): CatalogDescriptor | undefined {
    const descriptor = this.#snapshot.byPublicName.get(`${kind}:${value}`) ?? this.#snapshot.byPublicUri.get(`${kind}:${value}`);
    return descriptor && visibleToContext(descriptor, context) ? descriptor : undefined;
  }

  findVisible(context: AuthenticatedContext, kind: CatalogDescriptor["kind"], predicate: (descriptor: CatalogDescriptor) => boolean): CatalogDescriptor | undefined {
    return this.#snapshot.descriptors.find((descriptor) => descriptor.kind === kind && visibleToContext(descriptor, context) && predicate(descriptor));
  }

  schema(routeRef: string): CatalogSchemaValidators | undefined {
    return this.#snapshot.schemas.get(routeRef);
  }
}

export function createCatalogStore(descriptors: readonly CatalogDescriptor[] = []): CatalogStore {
  const store = new CatalogStore();
  if (descriptors.length > 0) store.publish(descriptors);
  return store;
}
