function element(tag, attributes = {}, text = "") {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "className") node.className = value;
    else node.setAttribute(name, value);
  }
  if (text) node.textContent = text;
  return node;
}

async function requestRepository(owner, repo, signal) {
  const response = await fetch(
    `/api/coding-github/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { credentials: "same-origin", signal }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error("GitHub Connector request failed.");
  return payload;
}

export function mountPluginConsole({ element: mountElement, signal } = {}) {
  if (!(mountElement instanceof Element)) throw new TypeError("GitHub Connector console mount element is required.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  const root = element("section", { className: "surface-card drawer-panel" });
  const heading = element("h4", {}, "GitHub Connector");
  const explanation = element(
    "p",
    {},
    "Repository requests use the enabled connector and current Operation Permission grant."
  );
  const owner = element("input", { autocomplete: "off", placeholder: "Repository owner" });
  const repo = element("input", { autocomplete: "off", placeholder: "Repository name" });
  const submit = element("button", { type: "button" }, "Read repository");
  const status = element("p", { role: "status" });

  submit.addEventListener("click", async () => {
    const ownerValue = owner.value.trim();
    const repoValue = repo.value.trim();
    if (!ownerValue || !repoValue) return;
    submit.disabled = true;
    status.textContent = "Loading…";
    try {
      const payload = await requestRepository(ownerValue, repoValue, controller.signal);
      const repository = payload.data && typeof payload.data === "object" ? payload.data : {};
      status.textContent = String(repository.name || "Repository available.");
    } catch {
      status.textContent = "Unable to read this repository.";
    } finally {
      submit.disabled = false;
    }
  });

  root.append(heading, explanation, owner, repo, submit, status);
  mountElement.replaceChildren(root);
  return () => {
    signal?.removeEventListener("abort", abort);
    controller.abort();
    root.remove();
  };
}
