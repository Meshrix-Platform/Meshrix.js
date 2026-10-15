import { afterEach, describe, expect, it, vi } from "vitest";

import { EntryApplicationPeerRouter } from "../../../apps/entry-gui/src/main/application-peer-router.ts";
import type { PeerApplicationAddress, PeerApplicationRouteAuthority } from "@meshrix/peer-client";

const address: PeerApplicationAddress = Object.freeze({
  tenantId: "tenant.personal",
  routeId: "route.personal",
  localDeviceId: "device.local",
  peerDeviceId: "device.remote"
});

afterEach(() => vi.useRealTimers());

describe("application route authority recovery", () => {
  it("observes an unavailable exact route until authority returns, independent of live transport registration", async () => {
    vi.useFakeTimers();
    let authority: PeerApplicationRouteAuthority = "unavailable";
    const resolved = vi.fn();
    const check = vi.fn(async () => authority);
    const router = new EntryApplicationPeerRouter({ resolvePeerAuthority: check });
    const unsubscribe = router.onAuthorityResolved(resolved);

    expect(await router.resolvePeerAuthority(address)).toBe("unavailable");
    expect(await router.isPeerReachable(address)).toBe(false);

    authority = "current";
    await vi.advanceTimersByTimeAsync(1_000);

    expect(check).toHaveBeenCalledTimes(2);
    expect(resolved).toHaveBeenCalledOnce();
    expect(resolved).toHaveBeenCalledWith(address, "current");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(2);

    unsubscribe();
    router.dispose();
  });

  it("clears an exact route observer when its accepted operation is cancelled", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async (): Promise<PeerApplicationRouteAuthority> => "unavailable");
    const router = new EntryApplicationPeerRouter({ resolvePeerAuthority: check });

    expect(await router.resolvePeerAuthority(address)).toBe("unavailable");
    router.clearAuthorityObservation(address);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(check).toHaveBeenCalledOnce();
    router.dispose();
  });
});
