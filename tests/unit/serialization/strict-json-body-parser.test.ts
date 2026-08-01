import { describe, expect, it } from "vitest";

import { parseStrictJsonBody } from "../../../packages/foundation/src/serialization/strict-json-body-parser.ts";

describe("parseStrictJsonBody", () : any => {
  it("rejects invalid JSON without returning an empty object", () : any => {
    const result: any = parseStrictJsonBody('{"token": "secret"', {
      traceId: "trace-test",
      contentType: "application/json",
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe("invalid_json");
    expect(result.error.metadata.traceId).toBe("trace-test");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects non-object JSON operation bodies", () : any => {
    for (const body of ["[1,2,3]", "null", "123", "\"abc\"", "true"]) {
      const result: any = parseStrictJsonBody(body);

      expect(result.success).toBe(false);
      expect(result.error.code).toBe("invalid_json");
    }
  });

  it("accepts valid JSON objects", () : any => {
    const result: any = parseStrictJsonBody('{"name":"workspace"}');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "workspace" });
  });
});
