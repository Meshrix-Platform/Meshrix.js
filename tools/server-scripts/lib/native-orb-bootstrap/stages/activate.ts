import { runOrb } from "../../native-orb-deployment/support.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  context.activationStarted = true;
  runOrb({ machine: context.parsed.machine, args: ["systemctl", "--user", "daemon-reload"], timeout: 30_000 });
  runOrb({ machine: context.parsed.machine, args: ["systemctl", "--user", "enable", "meshrix-js.service"], timeout: 30_000 });
  runOrb({ machine: context.parsed.machine, args: ["systemctl", "--user", "start", "meshrix-js.service"], timeout: 120_000, code: "native_orb_bootstrap_activation_failed" });
  return Object.freeze({ id: "activate", status: "completed" });
}
