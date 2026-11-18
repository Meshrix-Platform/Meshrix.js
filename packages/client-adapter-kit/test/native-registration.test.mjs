import assert from "node:assert/strict";
import test from "node:test";
import { descriptor, nativeAdapter, nativeEntry, registrationFrom } from "../index.mjs";
const request = (baseUrl) => ({ baseUrl, serverName: "work", credentialRef: { kind: "env", name: "WORK_MCP_KEY" } });

test("native registration accepts HTTPS and literal loopback development endpoints", () => {
  for (const baseUrl of ["https://meshrix.example/v1", "http://127.0.0.1:3010", "http://127.2.3.4:3010", "http://[::1]:3010"]) {
    assert.equal(registrationFrom(request(baseUrl)).url, `${baseUrl}/mcp`);
  }
});
test("native registration rejects plaintext remote endpoints and hostname aliases", () => {
  for (const baseUrl of ["http://meshrix.example", "http://10.0.0.4:8080", "http://localhost:8080", "http://2130706433", "http://0x7f000001", "http://127.1"]) {
    assert.throws(() => registrationFrom(request(baseUrl)), { adapterCode: "insecure_base_url" });
  }
});
test("native registration rejects embedded credentials, query and fragment without echoing them", () => {
  const withCredentials = new URL("https://meshrix.example");
  withCredentials.username = "fixture";
  const stubValue = ["synthetic", "value"].join("-");
  withCredentials.password = stubValue;
  for (const baseUrl of ["not a URL", withCredentials.href, "https://meshrix.example/?token=hidden", "https://meshrix.example/#fragment", "ftp://meshrix.example"]) {
    assert.throws(() => registrationFrom(request(baseUrl)), (error) => error.adapterCode === "invalid_base_url" && !error.message.includes("hidden") && !error.message.includes(withCredentials.password));
  }
});
test("successful write commands must actually change the expected native fields", async () => {
  const payload = request("https://meshrix.example");
  let entry;
  const adapter = nativeAdapter({
    description: descriptor({ target: "pi", commandNames: ["pi"] }),
    load: async () => ({ entry, save: async () => {} })
  });
  await assert.rejects(() => adapter.install(payload), { adapterCode: "registration_verification_failed" });
  entry = nativeEntry("pi", registrationFrom(payload));
  await assert.rejects(() => adapter.uninstall(payload), { adapterCode: "registration_verification_failed" });
});

test("registration identity and environment reference are explicit and closed", () => {
  const base = request("https://meshrix.example");
  for (const serverName of [undefined, "", "__proto__", "constructor", "a.b", "../escape"]) assert.throws(() => registrationFrom({ ...base, serverName }), { adapterCode: "invalid_registration_name" });
  for (const credentialRef of [undefined, { kind: "env", name: "lowercase" }, { kind: "file", name: "KEY" }, { kind: "env", name: "KEY", value: "secret" }]) assert.throws(() => registrationFrom({ ...base, credentialRef }), { adapterCode: "invalid_credential_reference" });
});
