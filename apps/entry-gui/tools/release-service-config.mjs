/** Validate and canonicalize the account and relay URLs embedded in a release. */
export function parseReleaseServiceInputs({ accountOrigin, relayService }) {
  if (typeof accountOrigin !== "string" || !accountOrigin || accountOrigin !== accountOrigin.trim()
    || typeof relayService !== "string" || !relayService || relayService !== relayService.trim()) {
    throw new Error("Set the release account HTTPS origin and relay WSS base URL before packaging.");
  }

  let account;
  let relay;
  try {
    account = new URL(accountOrigin);
    relay = new URL(relayService);
  } catch {
    throw new Error("The configured release service URLs are invalid.");
  }
  const relayPrefix = relay.pathname.replace(/\/+$/u, "");
  if (account.protocol !== "https:" || account.username || account.password
    || account.pathname !== "/" || account.search || account.hash
    || relay.protocol !== "wss:" || relay.username || relay.password
    || relayPrefix !== "/relay" || relay.search || relay.hash
    || account.host !== relay.host) {
    throw new Error("Use one HTTPS/WSS public host, with the WSS relay base at /relay.");
  }

  return Object.freeze({
    accountOrigin: account.origin,
    relayService: `${relay.protocol}//${relay.host}/relay`
  });
}
