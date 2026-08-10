const READ_ACTIONS = Object.freeze([
  Object.freeze({ label: "Refresh catalog", path: "/api/skill-hub/v1/skills" }),
  Object.freeze({ label: "Refresh statistics", path: "/api/skill-hub/v1/stats" }),
  Object.freeze({ label: "Refresh leaderboard", path: "/api/skill-hub/v1/leaderboard" })
]);

function element(name, attributes = {}, text = "") {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

export function mountPluginConsole({ element: root, signal } = {}) {
  if (!(root instanceof Element)) throw new TypeError("Skill Hub console requires a mount element.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const section = element("section", { class: "meshrix-plugin-console meshrix-plugin-console--skill-hub" });
  const output = element("pre", { "aria-live": "polite" }, "Choose a read action to inspect Skill Hub.");
  section.append(
    element("h2", {}, "Skill Hub"),
    element("p", {}, "Inspect governed contributions, adoption activity, and permission-aware usage."));
  const actions = element("div", { class: "meshrix-plugin-console__actions" });
  for (const action of READ_ACTIONS) {
    const button = element("button", { type: "button" }, action.label);
    button.addEventListener("click", async () => {
      button.disabled = true;
      output.textContent = "Loading…";
      try {
        const response = await fetch(action.path, {
          method: "GET",
          credentials: "same-origin",
          signal: controller.signal
        });
        const payload = await response.json().catch(() => ({}));
        output.textContent = response.ok
          ? JSON.stringify(payload, null, 2)
          : "The Skill Hub request was denied.";
      } catch (error) {
        output.textContent = error?.name === "AbortError"
          ? "Request cancelled."
          : "The Skill Hub request could not be completed.";
      } finally {
        button.disabled = false;
      }
    }, { signal: controller.signal });
    actions.append(button);
  }
  section.append(actions, output);
  root.replaceChildren(section);
  return () => {
    signal?.removeEventListener("abort", abort);
    controller.abort();
    root.replaceChildren();
  };
}
