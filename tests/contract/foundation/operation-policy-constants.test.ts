import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_AGENT_RISKS,
  normalizeRisk,
  riskRank,
  maxRisk
} from "../../../packages/contracts/src/operations/operation-policy-constants.ts";

describe("operation-policy-constants", () : any => {
  describe("normalizeRisk", () : any => {
    it("returns the fallback for empty, null, or undefined input", () : any => {
      expect(normalizeRisk("", "read_only")).toBe("read_only");
      expect(normalizeRisk(null, "read_only")).toBe("read_only");
      expect(normalizeRisk(undefined, "read_only")).toBe("read_only");
      expect(normalizeRisk("", "safe_write")).toBe("safe_write");
    });

    it("returns recognized risks as-is", () : any => {
      for (const risk of MAINTENANCE_AGENT_RISKS) {
        expect(normalizeRisk(risk)).toBe(risk);
      }
    });

    it("throws for unrecognized non-empty risk values", () : any => {
      expect(() : any => normalizeRisk("super_dangerous")).toThrow(
        /Unrecognized operation risk/
      );
      expect(() : any => normalizeRisk("unknown_risk")).toThrow(
        /Allowed risks:/
      );
      expect(() : any => normalizeRisk("read-only")).toThrow(); // hyphen not underscore
    });

    it("trims whitespace before matching", () : any => {
      expect(normalizeRisk("  read_only  ")).toBe("read_only");
      expect(normalizeRisk("\tsafe_write\n")).toBe("safe_write");
    });
  });

  describe("riskRank", () : any => {
    it("returns 0 for read_only", () : any => {
      expect(riskRank("read_only")).toBe(0);
    });

    it("returns increasing ranks for increasing risks", () : any => {
      expect(riskRank("read_only")).toBe(0);
      expect(riskRank("safe_write")).toBe(1);
      expect(riskRank("repair_write")).toBe(2);
      expect(riskRank("destructive")).toBe(3);
    });

    it("throws for unrecognized risk values", () : any => {
      expect(() : any => riskRank("super_dangerous")).toThrow(
        /Unrecognized operation risk/
      );
    });
  });

  describe("maxRisk", () : any => {
    it("returns the highest-ranked risk", () : any => {
      expect(maxRisk("read_only", "safe_write")).toBe("safe_write");
      expect(maxRisk("safe_write", "destructive")).toBe("destructive");
      expect(maxRisk("read_only", "read_only")).toBe("read_only");
    });

    it("returns read_only when called with no arguments", () : any => {
      expect(maxRisk()).toBe("read_only");
    });

    it("throws for any unrecognized risk", () : any => {
      expect(() : any => maxRisk("read_only", "bad_risk")).toThrow();
    });
  });
});
