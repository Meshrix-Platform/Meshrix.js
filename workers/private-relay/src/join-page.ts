/**
 * The invite-only join surface — a single dependency-free HTML page served
 * at `GET /join`. An invitee pastes the operator-minted code; the page
 * posts it to `/invite/redeem` and renders the enrollment payload (device
 * credential, wss relay URL, deep link for the installed Entry client).
 * There is deliberately no account system and no registration form:
 * the invitation is the identity, matching the product's
 * device-credential model.
 */

export const JOIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>Meshrix — Join</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(1200px 800px at 70% 20%, #14213d 0%, #0b0e14 60%);
    color: #e8ecf3; font: 15px/1.55 -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  }
  main { width: min(480px, 92vw); }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: .01em; margin: 0 0 6px; }
  .sub { color: #8b93a7; margin: 0 0 28px; font-size: 14px; }
  .card {
    background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.09);
    border-radius: 16px; padding: 28px; backdrop-filter: blur(14px);
  }
  label { display: block; font-size: 12px; color: #9aa3b8; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
  input[type=text] {
    width: 100%; padding: 12px 14px; border-radius: 10px; font: 13px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
    border: 1px solid rgba(255,255,255,.14); background: rgba(0,0,0,.35); color: #e8ecf3; outline: none;
  }
  input[type=text]:focus { border-color: #4d7cff; box-shadow: 0 0 0 3px rgba(77,124,255,.22); }
  button {
    margin-top: 18px; width: 100%; padding: 12px; border: 0; border-radius: 10px; cursor: pointer;
    background: #4d7cff; color: #fff; font: 600 15px/1 -apple-system, system-ui, sans-serif;
  }
  button:disabled { opacity: .45; cursor: default; }
  .msg { margin-top: 16px; font-size: 14px; min-height: 20px; }
  .err { color: #ff7d8a; }
  .ok { color: #7dffb0; }
  pre {
    margin: 14px 0 0; padding: 14px; border-radius: 10px; overflow-x: auto; font-size: 12px;
    background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.09); white-space: pre-wrap; word-break: break-all;
  }
  .hint { margin-top: 10px; font-size: 12px; color: #8b93a7; }
  .hidden { display: none; }
  a { color: #8faeff; }
</style>
</head>
<body>
<main>
  <h1>Join a private Meshrix route</h1>
  <p class="sub">Invitation only — no public registration. Paste the invite code your operator gave you.</p>
  <div class="card">
    <form id="f">
      <label for="invite">Invitation code</label>
      <input type="text" id="invite" name="invite" autocomplete="off" spellcheck="false" placeholder="inv2.…" required />
      <label for="device" style="margin-top:14px">Device ID <span style="text-transform:none">(yours to choose — identifies this device)</span></label>
      <input type="text" id="device" name="device" autocomplete="off" spellcheck="false" placeholder="dev.my-laptop.01" required />
      <button id="go" type="submit">Redeem invitation</button>
    </form>
    <div id="msg" class="msg"></div>
    <div id="result" class="hidden">
      <pre id="payload"></pre>
      <p class="hint">Paste this enrollment payload into your Meshrix Entry client (or open the deep link). It is shown once — store it safely.</p>
      <p class="hint"><a id="deeplink" href="#">Open in Meshrix Entry →</a></p>
    </div>
  </div>
</main>
<script>
const f = document.getElementById("f");
const invite = document.getElementById("invite");
const device = document.getElementById("device");
const msg = document.getElementById("msg");
const go = document.getElementById("go");
const result = document.getElementById("result");
const payload = document.getElementById("payload");
const deeplink = document.getElementById("deeplink");

// Pre-fill the code when the operator handed out a full join URL.
if (location.hash.length > 1) invite.value = decodeURIComponent(location.hash.slice(1));

f.addEventListener("submit", async (e) => {
  e.preventDefault();
  go.disabled = true; msg.className = "msg"; msg.textContent = "Verifying invitation…";
  result.classList.add("hidden");
  try {
    const res = await fetch("/invite/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: invite.value.trim(), deviceId: device.value.trim() })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const map = {
        invite_invalid: "This invitation code is not valid.",
        invite_spent: "This invitation has already been fully redeemed.",
        already_redeemed: "That device ID already redeemed this invitation.",
        already_enrolled: "That device ID is already enrolled — pick another.",
        role_occupied: "The route slot for this role is already taken.",
        tenant_mismatch: "Invitation does not belong to this relay's tenant.",
        rate_limited: "Too many attempts — wait a minute and retry."
      };
      msg.className = "msg err";
      msg.textContent = map[body.error] || ("Redemption failed: " + (body.error || res.status));
      return;
    }
    const enrollment = {
      wss: location.origin.replace(/^http/, "wss"),
      tenantId: body.tenantId, routeId: body.routeId,
      deviceId: body.deviceId, role: body.role, credential: body.credential
    };
    msg.className = "msg ok"; msg.textContent = "Invitation accepted — device enrolled.";
    payload.textContent = JSON.stringify(enrollment, null, 2);
    deeplink.href = "meshrix-entry://join?payload=" + encodeURIComponent(JSON.stringify(enrollment));
    result.classList.remove("hidden");
  } catch (err) {
    msg.className = "msg err"; msg.textContent = "Network error — could not reach the relay.";
  } finally {
    go.disabled = false;
  }
});
</script>
</body>
</html>
`;
