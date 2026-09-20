import { describe, expect, it } from "vitest";
import { CatalogStore, createStableAlias } from "@meshrix/gateway";
import { context, descriptor, route } from "../support";

describe("gateway catalog and routing snapshots", () => {
  it("[CASE-C01] publishes immutable routes with stable collision aliases", () => {
    const store = new CatalogStore();
    store.publish([
      descriptor({ upstreamName: "same", route: route({ logicalRoute: "r1" }) }),
      descriptor({ upstreamName: "same", route: route({ logicalRoute: "r2", revision: "route-2" }) })
    ]);
    const page = store.page(context, { kind: "tool", limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].publicName).not.toBe(page.items[1].publicName);
    expect(createStableAlias("tool", "upstream", "hello world")).toMatch(/^mx_tool_hello_world_/u);
    expect(() => (store.snapshot().routes as Map<string, unknown>).set("bad", {})).toThrowError();
  });

  it("[CASE-C02] [CASE-C03] binds cursors to the authorization partition and snapshot revision", () => {
    const store = new CatalogStore();
    store.publish(Array.from({ length: 3 }, (_, index) => descriptor({ publicName: `tool-${index}`, route: route({ logicalRoute: `r-${index}`, revision: `route-${index}` }) })));
    const first = store.page(context, { kind: "tool", limit: 1 });
    expect(first.nextCursor).toBeTypeOf("string");
    const other = { ...context, principal: "other-principal" };
    expect(() => store.page(other, { kind: "tool", limit: 1, cursor: first.nextCursor })).toThrowError(/another authorization partition/u);
    store.publish([descriptor({ route: route({ logicalRoute: "new-route", revision: "new" }) })]);
    expect(() => store.page(context, { kind: "tool", limit: 1, cursor: first.nextCursor })).toThrowError(/older snapshot/u);
  });

  it("filters catalog visibility by grant routes without using a client product name", () => {
    const store = new CatalogStore();
    store.publish([descriptor({ route: route({ logicalRoute: "allowed" }) }), descriptor({ publicName: "hidden", route: route({ logicalRoute: "hidden" }) })]);
    const page = store.page({ ...context, grant: { revision: "grant-1", routes: ["allowed"] } }, { kind: "tool" });
    expect(page.items.map((item) => item.publicName)).toEqual(["demo"]);
  });
});

