import type { CatalogDescriptor, RouteSnapshot } from "@meshrix/contracts/gateway";
import { CatalogStore } from "../catalog/index.ts";

export class RouteRegistry {
  readonly catalog: CatalogStore;

  constructor(catalog = new CatalogStore()) {
    this.catalog = catalog;
  }

  publish(descriptors: readonly CatalogDescriptor[]): string {
    return this.catalog.publish(descriptors);
  }

  resolve(routeRef: string): RouteSnapshot {
    const route = this.catalog.resolve(routeRef);
    if (!route) throw Object.assign(new Error(`Unknown gateway route: ${routeRef}`), { code: "route_not_found", status: 404 });
    return route;
  }

  descriptor(routeRef: string): CatalogDescriptor {
    const descriptor = this.catalog.descriptor(routeRef);
    if (!descriptor) throw Object.assign(new Error(`Unknown gateway route: ${routeRef}`), { code: "route_not_found", status: 404 });
    return descriptor;
  }
}

export function createRouteRegistry(descriptors: readonly CatalogDescriptor[] = []): RouteRegistry {
  const registry = new RouteRegistry();
  if (descriptors.length > 0) registry.publish(descriptors);
  return registry;
}

