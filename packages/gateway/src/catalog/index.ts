import type {
  AuthenticatedContext,
  CatalogDescriptor,
  CatalogPage,
  CatalogPort,
  CatalogQuery,
  RouteSnapshot
} from "@meshrix/contracts/gateway";
import { canonicalJson, cloneJson, deepFreeze, digest, isPlainRecord } from "../utils.ts";
import { createSchemaValidator, type CompiledExternalSchema } from "../schema/index.ts";

export interface CatalogSchemaValidators {
  readonly input?: CompiledExternalSchema;
  readonly output?: CompiledExternalSchema;
}

export interface CatalogSnapshot {
  readonly revision: string;
  readonly descriptors: readonly CatalogDescriptor[];
  readonly routes: ReadonlyMap<string, RouteSnapshot>;
  readonly schemas: ReadonlyMap<string, CatalogSchemaValidators>;
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
  const baseName = descriptor.publicName ?? (descriptor.upstreamName ? createStableAlias(descriptor.kind, route.upstreamIdentity, descriptor.upstreamName) : undefined);
  const baseUri = descriptor.publicUri ?? (descriptor.upstreamUri ? `meshrix://${route.upstreamIdentity}/${digest(descriptor.upstreamUri).slice(0, 20)}` : undefined);
  let publicName = baseName;
  if (baseName) {
    const initialName = baseName;
    let suffix = 12;
    while (usedNames.has(`${descriptor.kind}:${publicName}`)) {
      publicName = `${initialName.slice(0, 90)}_${digest({ route: route.logicalRoute, upstreamName: descriptor.upstreamName }).slice(0, suffix)}`;
      suffix += 4;
    }
    usedNames.add(`${descriptor.kind}:${publicName}`);
  }
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
  const routes = [
    ...(Array.isArray(context.grant.routes) ? context.grant.routes : []),
    ...(Array.isArray(context.grant.routeRefs) ? context.grant.routeRefs : [])
  ].filter((value): value is string => typeof value === "string");
  return routes.length === 0 || routes.includes(descriptor.route.logicalRoute);
}

export class CatalogStore implements CatalogPort {
  readonly #schemaValidator = createSchemaValidator();
  #snapshot: CatalogSnapshot = Object.freeze({ revision: "r0", descriptors: Object.freeze([]), routes: readOnlyMap(new Map()), schemas: readOnlyMap(new Map()) });

  publish(descriptors: readonly CatalogDescriptor[]): string {
    const usedNames = new Set<string>();
    const normalized = descriptors.map((descriptor) => normalizeDescriptor(descriptor, usedNames));
    const routes = new Map<string, RouteSnapshot>();
    const schemas = new Map<string, CatalogSchemaValidators>();
    for (const descriptor of normalized) {
      routes.set(descriptor.route.logicalRoute, descriptor.route);
      const input = descriptor.inputSchema === undefined
        ? undefined
        : this.#schemaValidator.compile(descriptor.inputSchema, `Input schema for ${descriptor.route.logicalRoute}`);
      const output = descriptor.outputSchema === undefined
        ? undefined
        : this.#schemaValidator.compile(descriptor.outputSchema, `Output schema for ${descriptor.route.logicalRoute}`);
      if (input || output) schemas.set(descriptor.route.logicalRoute, Object.freeze({ ...(input ? { input } : {}), ...(output ? { output } : {}) }));
    }
    const revision = `r${Number(this.#snapshot.revision.slice(1) || 0) + 1}`;
    this.#snapshot = Object.freeze({
      revision,
      descriptors: Object.freeze(normalized),
      routes: readOnlyMap(routes),
      schemas: readOnlyMap(schemas)
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
    let offset = 0;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (cursor.partition !== key || cursor.query !== queryKey(query)) throw cursorError("catalog_cursor_forbidden", "Catalog cursor belongs to another authorization partition.");
      if (cursor.revision !== snapshot.revision) throw cursorError("catalog_cursor_expired", "Catalog cursor refers to an older snapshot.");
      offset = Number(cursor.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) throw cursorError("catalog_cursor_invalid", "Catalog cursor offset is invalid.");
    }
    const search = query.search?.toLocaleLowerCase() ?? "";
    const filtered = snapshot.descriptors.filter((descriptor) => {
      if (!visibleToContext(descriptor, context)) return false;
      if (query.kind && descriptor.kind !== query.kind) return false;
      if (!search) return true;
      return [descriptor.publicName, descriptor.publicUri, descriptor.description]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(search));
    });
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length
      ? encodeCursor({ revision: snapshot.revision, partition: key, query: queryKey(query), offset: nextOffset })
      : undefined;
    return Object.freeze({ revision: snapshot.revision, items: Object.freeze(items), ...(nextCursor ? { nextCursor } : {}) });
  }

  resolve(routeRef: string): RouteSnapshot | undefined {
    return this.#snapshot.routes.get(routeRef);
  }

  descriptor(routeRef: string): CatalogDescriptor | undefined {
    return this.#snapshot.descriptors.find((descriptor) => descriptor.route.logicalRoute === routeRef);
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
