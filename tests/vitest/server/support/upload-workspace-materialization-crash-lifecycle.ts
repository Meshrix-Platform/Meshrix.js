export interface CrashChildOwnerProcess {
  once(event: "disconnect", listener: () => void): unknown;
}

export interface CrashChildController extends CrashChildOwnerProcess {
  connected?: boolean;
  disconnect(): void;
}

export type CrashChildExit = readonly [number | null, NodeJS.Signals | null];

export function exitCrashChildWhenOwnerDisconnects(
  owner: CrashChildOwnerProcess,
  exit: () => void
): void {
  owner.once("disconnect", exit);
}

export async function terminateOwnedCrashChild(
  child: CrashChildController,
  terminateOwnedProcessGroup: () => void,
  exited: Promise<CrashChildExit>
): Promise<CrashChildExit> {
  terminateOwnedProcessGroup();
  if (child.connected !== false) child.disconnect();
  return exited;
}
