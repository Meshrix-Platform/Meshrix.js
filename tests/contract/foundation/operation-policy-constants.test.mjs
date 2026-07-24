import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_AGENT_RISKS,
  normalizeRisk,
  riskRank,
  maxRisk
} from "../../../packages/contracts/src/operations/operation-policy-constants.mjs";

describe("operation-policy-constants", () => {
  describe("normalizeRisk", () => {
    it("returns the fallback for empty, null, or undefined input", () => {
      expect(normalizeRisk("", "read_only")).toBe("read_only");
      expect(normalizeRisk(null, "read_only")).toBe("read_only");
      expect(normalizeRisk(undefined, "read_only")).toBe("read_only");
      expect(normalizeRisk("", "safe_write")).toBe("safe_write");
    });

    it("returns recognized risks as-is", () => {
      for (const risk of MAINTENANCE_AGENT_RISKS) {
        expect(normalizeRisk(risk)).toBe(risk);
      }
    });

    it("throws for unrecognized non-empty risk values", () => {
      expect(() => normalizeRisk("super_dangerous")).toThrow(
        /Unrecognized operation risk/
      );
      expect(() => normalizeRisk("unknown_risk")).toThrow(
        /Allowed risks:/
      );
      expect(() => normalizeRisk("read-only")).toThrow(); // hyphen not underscore
    });

    it("trims whitespace before matching", () => {
      expect(normalizeRisk("  read_only  ")).toBe("read_only");
      expect(normalizeRisk("\tsafe_write\n")).toBe("safe_write");
    });
  });

  describe("riskRank", () => {
    it("returns 0 for read_only", () => {
      expect(riskRank("read_only")).toBe(0);
    });

    it("returns increasing ranks for increasing risks", () => {
      expect(riskRank("read_only")).toBe(0);
      expect(riskRank("safe_write")).toBe(1);
      expect(riskRank("repair_write")).toBe(2);
      expect(riskRank("destructive")).toBe(3);
    });

    it("throws for unrecognized risk values", () => {
      expect(() => riskRank("super_dangerous")).toThrow(
        /Unrecognized operation risk/
      );
    });
  });

  describe("maxRisk", () => {
    it("returns the highest-ranked risk", () => {
      expect(maxRisk("read_only", "safe_write")).toBe("safe_write");
      expect(maxRisk("safe_write", "destructive")).toBe("destructive");
      expect(maxRisk("read_only", "read_only")).toBe("read_only");
    });

    it("returns read_only when called with no arguments", () => {
      expect(maxRisk()).toBe("read_only");
    });

    it("throws for any unrecognized risk", () => {
      expect(() => maxRisk("read_only", "bad_risk")).toThrow();
    });
  });
});
