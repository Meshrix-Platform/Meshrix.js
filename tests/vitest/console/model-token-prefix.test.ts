import { describe, expect, it } from "vitest";

import { normalizeAgentModelEntry } from "../../../apps/console/composables/console-model-utils";

describe("model credential prefix normalization", () : any => {
  it("preserves the separator required by Bearer authorization", () : any => {
    const entry: any = normalizeAgentModelEntry({
      uid: "agent_openai_explicit",
      provider: "openai",
      tokenHeader: "Authorization",
      tokenPrefix: "Bearer ",
    });

    expect(entry.tokenPrefix).toBe("Bearer ");
  });

  it("rejects header-injection control characters", () : any => {
    expect(() : any => normalizeAgentModelEntry({
      uid: "agent_openai_explicit",
      provider: "openai",
      tokenPrefix: "Bearer\nInjected: yes",
    })).toThrow(/不能包含换行/u);
    expect(() : any => normalizeAgentModelEntry({
      uid: "agent_openai_explicit",
      provider: "openai",
      tokenHeader: "Host",
    })).toThrow(/保留或逐跳字段/u);
    expect(() : any => normalizeAgentModelEntry({
      uid: "agent_openai_explicit",
      provider: "openai",
      baseUrl: ["https://user", "password@example.test/v1?credential=value"].join(":"),
    })).toThrow(/不能包含用户信息/u);
  });
});
