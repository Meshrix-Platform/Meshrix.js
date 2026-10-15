import assert from "node:assert/strict";
import test from "node:test";

import { connectorFrom } from "../index.mjs";

const request = (baseUrl) => ({
  baseUrl,
  connector: { command: "meshrix-mcp", args: [] }
});

test("connector accepts HTTPS endpoints and literal loopback HTTP development endpoints", () => {
  for (const baseUrl of [
    "https://meshrix.example/v1",
    "http://127.0.0.1:3010",
    "http://127.2.3.4:3010",
    "http://[::1]:3010"
  ]) {
    const connector = connectorFrom(request(baseUrl), "codex");
    assert.equal(connector.args.at(-3), baseUrl);
  }
});

test("connector rejects remote plaintext HTTP and hostname aliases", () => {
  for (const baseUrl of [
    "http://meshrix.example",
    "http://10.0.0.4:8080",
    "http://localhost:8080",
    "http://meshrix.internal:8080"
  ]) {
    assert.throws(() => connectorFrom(request(baseUrl), "codex"), (error) => {
      assert.equal(error.adapterCode, "insecure_base_url");
      assert.match(error.message, /literal loopback/u);
      return true;
    });
  }
});

test("connector rejects malformed endpoints and URL-embedded credentials or routing data", () => {
  const embeddedCredentialUrl = new URL("http://127.0.0.1:3010");
  embeddedCredentialUrl.username = ["fixture", "user"].join("-");
  embeddedCredentialUrl.password = ["fixture", "password"].join("-");
  for (const baseUrl of [
    "not a URL",
    embeddedCredentialUrl.toString(),
    "https://meshrix.example/?token=hidden",
    "https://meshrix.example/#fragment",
    "ftp://meshrix.example"
  ]) {
    assert.throws(() => connectorFrom(request(baseUrl), "codex"), (error) => {
      assert.equal(error.adapterCode, "invalid_base_url");
      assert.equal(error.message.includes("hidden"), false);
      assert.equal(error.message.includes("fixture"), false);
      return true;
    });
  }
});
