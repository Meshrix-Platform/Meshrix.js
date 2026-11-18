import {
  bindJobChangeSetSeam,
  bindWorkspaceChangeSetSeam,
  CORE_CHANGE_SET_AUTHORITY_ID
} from "../core-change-set-authority.ts";

export {
  bindJobChangeSetSeam,
  bindWorkspaceChangeSetSeam,
  CORE_CHANGE_SET_AUTHORITY_ID
};

export function createAgentWorkspaceChangeSetSeam(
  authority?: Parameters<typeof bindWorkspaceChangeSetSeam>[0]
): ReturnType<typeof bindWorkspaceChangeSetSeam> {
  return bindWorkspaceChangeSetSeam(authority);
}

export function createJobStateChangeSetSeam(
  authority?: Parameters<typeof bindJobChangeSetSeam>[0]
): ReturnType<typeof bindJobChangeSetSeam> {
  return bindJobChangeSetSeam(authority);
}
