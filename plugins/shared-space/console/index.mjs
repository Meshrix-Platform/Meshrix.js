const ROUTE_ROOT = "/api/agent-workspaces";

function encode(value) {
  return encodeURIComponent(String(value || ""));
}

async function requestJson(url, { method = "GET", body, signal } = {}) {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Shared Space request failed.");
  return payload;
}

function element(tag, attributes = {}, text = "") {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "className") node.className = value;
    else if (name === "type") node.type = value;
    else node.setAttribute(name, value);
  }
  if (text) node.textContent = text;
  return node;
}

export function mountPluginConsole({ element: mountElement, signal } = {}) {
  if (!(mountElement instanceof Element)) throw new TypeError("Shared Space console mount element is required.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  const root = element("section", { className: "surface-card drawer-panel" });
  const heading = element("h4", {}, "Shared Space local directory");
  const workspace = element("input", { autocomplete: "off", placeholder: "Workspace reference" });
  const sourcePath = element("input", { autocomplete: "off", placeholder: "Local directory path" });
  const target = element("input", { autocomplete: "off", placeholder: "Workspace target path" });
  const connect = element("button", { type: "button" }, "Connect directory");
  const refresh = element("button", { type: "button" }, "Refresh mounts");
  const status = element("p", { role: "status" });
  const list = element("ul");

  async function loadMounts() {
    const workspaceId = workspace.value.trim();
    if (!workspaceId) return;
    status.textContent = "Loading…";
    try {
      const payload = await requestJson(`${ROUTE_ROOT}/${encode(workspaceId)}/local-dir/mounts`, { signal: controller.signal });
      list.replaceChildren(...(payload.mounts || []).map((mount) => {
        const item = element("li");
        const label = element(
          "span",
          {},
          `${String(mount.mountRef || "").slice(0, 22)} → ${String(mount.targetPath || "root")}`
        );
        const sync = element("button", { type: "button" }, "Sync");
        sync.addEventListener("click", async () => {
          const mountRef = String(mount.mountRef || "").trim();
          if (!mountRef) return;
          sync.disabled = true;
          status.textContent = "Synchronizing…";
          try {
            await requestJson(`${ROUTE_ROOT}/${encode(workspaceId)}/local-dir/sync/apply`, {
              method: "POST",
              body: {
                mountRef,
                targetPath: String(mount.targetPath || ""),
                deleteExtraneous: true
              },
              signal: controller.signal
            });
            status.textContent = "Synchronization completed.";
          } catch {
            status.textContent = "Unable to synchronize this mount.";
          } finally {
            sync.disabled = false;
          }
        });
        item.append(label, sync);
        return item;
      }));
      status.textContent = `${(payload.mounts || []).length} mount(s)`;
    } catch {
      status.textContent = "Unable to load Shared Space mounts.";
    }
  }

  connect.addEventListener("click", async () => {
    const workspaceId = workspace.value.trim();
    const selectedPath = sourcePath.value.trim();
    if (!workspaceId || !selectedPath) return;
    connect.disabled = true;
    status.textContent = "Connecting…";
    try {
      await requestJson(`${ROUTE_ROOT}/${encode(workspaceId)}/local-dir/connect`, {
        method: "POST",
        body: { sourcePath: selectedPath, targetPath: target.value.trim(), deleteExtraneous: true, maxFiles: 2000 },
        signal: controller.signal
      });
      sourcePath.value = "";
      await loadMounts();
    } catch {
      status.textContent = "Unable to connect the selected directory.";
    } finally {
      connect.disabled = false;
    }
  });
  refresh.addEventListener("click", () => { void loadMounts(); });
  root.append(heading, workspace, sourcePath, target, connect, refresh, status, list);
  mountElement.replaceChildren(root);

  return () => {
    signal?.removeEventListener("abort", abort);
    controller.abort();
    root.remove();
  };
}
