import { describe, expect, it } from "vitest";

import { parseConsoleAdminViewSelection } from "../../../tools/server-scripts/lib/console-admin-browser-fixture";

const entries: any = Object.freeze([
  { viewKey: "jobs" },
  { viewKey: "opsMonitor" },
  { viewKey: "managedEndpoints" },
]);

describe("parseConsoleAdminViewSelection", (): any => {
  it("returns the empty selection when --views is absent", (): any => {
    expect(parseConsoleAdminViewSelection(["--other", "x"], entries)).toEqual([]);
    expect(parseConsoleAdminViewSelection([], entries)).toEqual([]);
  });

  it("rejects a missing --views argument before any setup", (): any => {
    expect((): any => parseConsoleAdminViewSelection(["--views"], entries)).toThrow(
      /--views/u,
    );
  });

  it("rejects blank and comma-only arguments", (): any => {
    expect((): any => parseConsoleAdminViewSelection(["--views", "   "], entries)).toThrow(
      /--views/u,
    );
    expect((): any => parseConsoleAdminViewSelection(["--views", ","], entries)).toThrow(
      /--views/u,
    );
    expect((): any => parseConsoleAdminViewSelection(["--views", ",,"], entries)).toThrow(
      /--views/u,
    );
  });

  it("rejects unregistered viewKeys", (): any => {
    expect(
      (): any => parseConsoleAdminViewSelection(["--views", "managedEndpoints,notARoute"], entries),
    ).toThrow(/notARoute/u);
  });

  it("returns deduplicated registered viewKeys in request order", (): any => {
    expect(
      parseConsoleAdminViewSelection(
        ["--views", "managedEndpoints, managedEndpoints ,jobs"],
        entries,
      ),
    ).toEqual(["managedEndpoints", "jobs"]);
  });
});
