import fs from "node:fs";

export const CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION: any = Object.freeze(JSON.parse(fs.readFileSync(
  new URL("./workspace-contribution.lifecycle.json", import.meta.url),
  "utf8"
)));
