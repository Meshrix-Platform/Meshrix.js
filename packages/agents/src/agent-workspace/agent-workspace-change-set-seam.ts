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

export function createAgentWorkspaceChangeSetSeam(authority?: any) : any {
  return bindWorkspaceChangeSetSeam(authority);
}

export function createJobStateChangeSetSeam(authority?: any) : any {
  return bindJobChangeSetSeam(authority);
}
