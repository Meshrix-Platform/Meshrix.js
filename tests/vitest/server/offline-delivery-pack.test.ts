import { describe, expect, it } from "vitest";

import {
  OFFLINE_DELIVERY_PACK_RELATIVE_OCI,
  OFFLINE_DELIVERY_PACK_RELATIVE_OUTPUT,
  buildOfflineDeliveryPackReceipt,
} from "../../../tools/server-scripts/offline-delivery-pack.ts";
import { produceOfflineDeliveryBundle } from "../../../tools/server-scripts/offline-delivery-producer.ts";

const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;

describe("offline delivery operator pack", () : any => {
  it("writes a repo-relative signed bundle and refuses contract-fixture bytes", async () : Promise<any> => {
    expect(OFFLINE_DELIVERY_PACK_RELATIVE_OUTPUT).toBe("build/offline-delivery-bundle");
    expect(OFFLINE_DELIVERY_PACK_RELATIVE_OCI).toBe("build/offline-delivery-oci");
    expect(OFFLINE_DELIVERY_PACK_RELATIVE_OUTPUT.startsWith("/")).toBe(false);
    expect(() : any => buildOfflineDeliveryPackReceipt({
      produced: {
        contractFixtureUsed: true,
        platforms: ["linux/amd64", "linux/arm64"],
      },
    })).toThrow(/contract-fixture/);
    await expect(produceOfflineDeliveryBundle({
      outputRoot: "build/offline-delivery-bundle",
      allowContractFixture: false,
    })).rejects.toMatchObject({
      code: "offline_delivery_candidate_materials_missing",
    });
    const receipt: any = buildOfflineDeliveryPackReceipt({
      produced: {
        contractFixtureUsed: false,
        platforms: ["linux/amd64", "linux/arm64"],
        hasInventory: true,
        hasSbom: true,
        hasProvenance: true,
        hasSignatures: true,
        bundle: { image_digest: "sha256:abc" },
        outputRoot: "/Users/example/Meshrix.js/build/offline-delivery-bundle",
      },
    });
    expect(receipt).toEqual({
      ok: true,
      output: "build/offline-delivery-bundle",
      platforms: ["linux/amd64", "linux/arm64"],
      contractFixtureUsed: false,
      hasInventory: true,
      hasSbom: true,
      hasProvenance: true,
      hasSignatures: true,
      imageDigest: "sha256:abc",
    });
    expect(JSON.stringify(receipt)).not.toMatch(ABSOLUTE_PATH_PATTERN);
  });
});
