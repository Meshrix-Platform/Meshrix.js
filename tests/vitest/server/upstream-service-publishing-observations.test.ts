import { describe, expect, it } from "vitest";

import {
  UPSTREAM_SERVICE_PUBLISHING_BOUNDARIES,
  UPSTREAM_SERVICE_PUBLISHING_COUNTERS,
  UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_EVENTS,
  UPSTREAM_SERVICE_PUBLISHING_SCENARIOS,
  reduceUpstreamServicePublishingObservations
} from "../../../tools/server-scripts/lib/upstream-service-publishing-evidence.ts";

function canonicalObservations() : any {
  return structuredClone(UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_EVENTS);
}

function mutate(mutator?: any) : any {
  const observations: any = canonicalObservations();
  mutator(observations);
  return observations;
}

describe("upstream service publishing primitive observations", () : any => {
  it("derives every report projection from the exact primitive event set", () : any => {
    const reduced: any = reduceUpstreamServicePublishingObservations(canonicalObservations());
    expect(UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_EVENTS).toHaveLength(67);
    expect(reduced.productionBoundaries.map(({ id }: Record<string, any>) : any => id)).toEqual(UPSTREAM_SERVICE_PUBLISHING_BOUNDARIES);
    expect(reduced.revisionEdges.map(({ scenario }: Record<string, any>) : any => scenario)).toEqual(UPSTREAM_SERVICE_PUBLISHING_SCENARIOS);
    expect(reduced.scenarios.map(({ id }: Record<string, any>) : any => id)).toEqual(UPSTREAM_SERVICE_PUBLISHING_SCENARIOS);
    expect(Object.keys(reduced.counters)).toEqual(UPSTREAM_SERVICE_PUBLISHING_COUNTERS);
    expect(reduced.counters).toMatchObject({
      writes: 6,
      snapshotSwaps: 7,
      catalogCommits: 6,
      publicationEvents: 6,
      invalidationsDelivered: 2,
      catalogPulls: 9,
      acknowledgements: 1,
      sessionDisconnects: 2,
      reconnectFences: 1,
      upstreamCalls: 3,
      deniedExecutions: 2
    });
  });

  it.each([
    ["missing event", (events?: any) : any => { events.pop(); }],
    ["duplicate event", (events?: any) : any => { events[1] = structuredClone(events[0]); }],
    ["reordered event", (events?: any) : any => { [events[0], events[1]] = [events[1], events[0]]; }],
    ["substituted id", (events?: any) : any => { events[0].id = "auth.substituted.denied"; }],
    ["substituted status", (events?: any) : any => { events[2].status = "rejected"; }],
    ["substituted scenario", (events?: any) : any => { events[2].scenario = "replace"; }],
    ["substituted source revision", (events?: any) : any => { events[2].fromRevision = 1; }],
    ["substituted target revision", (events?: any) : any => { events[2].toRevision = 0; }],
    ["substituted count", (events?: any) : any => { events[7].count = 2; }],
    ["zero count", (events?: any) : any => { events[0].count = 0; }],
    ["unknown event field", (events?: any) : any => { events[0].passed = true; }],
    ["missing direct fact", (events?: any) : any => { delete events.find((event?: any) : any => event.id === "runtime.create.visible").fact; }],
    ["forged counter delta", (events?: any) : any => {
      events.find((event?: any) : any => event.id === "runtime.create.visible").fact.counterDelta.snapshotSwaps = 2;
    }],
    ["accepted event impersonating a swap", (events?: any) : any => {
      const event: any = events.find((entry?: any) : any => entry.id === "create.accepted");
      event.fact.type = "runtime_snapshot";
      event.fact.counterDelta.writes = 0;
      event.fact.counterDelta.snapshotSwaps = 1;
    }],
    ["duplicated direct publication fact", (events?: any) : any => {
      const create: any = events.find((event?: any) : any => event.id === "runtime.create.visible");
      const replace: any = events.find((event?: any) : any => event.id === "runtime.replace-first.visible");
      replace.fact.sourceRevision = create.fact.sourceRevision;
      replace.fact.sourceDigest = create.fact.sourceDigest;
    }],
    ["missing public terminal reference", (events?: any) : any => {
      events.find((event?: any) : any => event.id === "publication.republish.server-published")
        .fact.publicationRefObserved = false;
    }],
    ["divergent terminal protocol revision", (events?: any) : any => {
      events.find((event?: any) : any => event.id === "publication.republish.server-published")
        .fact.protocolRevision += 1;
    }],
    ["restart catalog substitution", (events?: any) : any => {
      events.find((event?: any) : any => event.id === "restart.snapshot-restored")
        .fact.catalogRevision = "c".repeat(64);
    }]
  ])("rejects %s instead of repairing the observation set", (_label?: any, mutator?: any) : any => {
    expect(() : any => reduceUpstreamServicePublishingObservations(mutate(mutator))).toThrow();
  });
});
