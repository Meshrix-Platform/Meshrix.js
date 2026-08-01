import { describe, expect, it } from "vitest";

import {
  SECRET_REPLACEMENT_PREFIX,
  createDefaultRedactionTrie,
} from "../../../packages/foundation/src/security/redaction/redaction-trie.ts";

describe("RedactionTrie", () : any => {
  it("redacts direct secret fields and token-like values in audit records", () : any => {
    const trie: any = createDefaultRedactionTrie();
    const audit: any = trie.createRedactedAuditRecord({
      password: "correct-horse-battery-staple",
      nested: {
        apiKey: "fixture-api-key-value",
      },
      publicLabel: "safe",
    });

    expect(audit.redactedInput.password).toBe("[redacted]");
    expect(audit.redactedInput.nested.apiKey).toMatch(SECRET_REPLACEMENT_PREFIX);
    expect(audit.redactedInput.publicLabel).toBe("safe");
    expect(JSON.stringify(audit.redactedInput)).not.toContain("correct-horse");
    expect(JSON.stringify(audit.redactedInput)).not.toContain("fixture-api-key-value");
  });

  it("stores secret refs for authorization headers and OAuth query codes", () : any => {
    const trie: any = createDefaultRedactionTrie();
    const jwtFixture: any = ["eyJaaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"].join(".");
    const redacted: any = trie.redact({
      headers: {
        authorization: `Bearer ${jwtFixture}`,
        cookie: "sid=secret",
        "x-api-key": "fixture-header-key",
      },
      query: {
        code: "oauth-code",
      },
    });

    expect(redacted.headers.authorization).toMatch(SECRET_REPLACEMENT_PREFIX);
    expect(redacted.headers.cookie).toMatch(SECRET_REPLACEMENT_PREFIX);
    expect(redacted.headers["x-api-key"]).toMatch(SECRET_REPLACEMENT_PREFIX);
    expect(redacted.query.code).toMatch(SECRET_REPLACEMENT_PREFIX);
  });
});
