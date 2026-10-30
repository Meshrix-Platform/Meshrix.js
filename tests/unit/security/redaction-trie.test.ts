import { describe, expect, it } from "vitest";

import {
  SECRET_REPLACEMENT_PREFIX,
  createDefaultRedactionTrie,
} from "../../../packages/foundation/src/security/redaction/redaction-trie.ts";
const canned1 = "correct-horse-battery-staple";
const canned2 = "fixture-api-key-value";
const canned3 = "fixture-header-key";




describe("RedactionTrie", () : any => {
  it("redacts direct secret fields and token-like values in audit records", () : any => {
    const trie: any = createDefaultRedactionTrie();
    const audit: any = trie.createRedactedAuditRecord({
      password: canned1,
      nested: {
        apiKey: canned2,
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
    const canned4 = ["eyJaaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"].join(".");
    const jwtFixture: any = canned4;
    const redacted: any = trie.redact({
      headers: {
        authorization: ("Bearer "+jwtFixture),
        cookie: "sid=secret",
        "x-api-key": canned3,
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
