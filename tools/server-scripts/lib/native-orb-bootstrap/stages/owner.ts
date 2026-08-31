import path from "node:path";
import crypto from "node:crypto";
import { runOrb } from "../../native-orb-deployment/support.ts";
import { failNativeOrbBootstrap } from "../contract.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  const serialized: any = context.ownerCredentialBytes;
  if (!Buffer.isBuffer(serialized) || serialized.byteLength === 0 || serialized.byteLength > 8 * 1024) {
    failNativeOrbBootstrap("native_orb_bootstrap_owner_input_missing", "Private owner input is unavailable.");
  }
  if (!context.secretsReady) {
    failNativeOrbBootstrap("native_orb_bootstrap_secret_custody_incomplete", "Secret custody is incomplete.");
  }
  const configTemporary: any = `${context.layout.runtimeConfigPath}.${context.sourceRevision}.tmp`;
  const unitTemporary: any = `${context.layout.unitPath}.${context.sourceRevision}.tmp`;
  runOrb({ machine: context.parsed.machine, args: ["install", "-d", "-m", "0700", path.posix.dirname(context.layout.unitPath)] });
  const configExact: any = remoteFileExact(context, context.layout.runtimeConfigPath, context.runtimeConfigContents);
  const unitExact: any = remoteFileExact(context, context.layout.unitPath, context.unitContents);
  const result: any = runOrb({
    machine: context.parsed.machine,
    args: ["sh", "-lc", "cd \"$1\" && exec \"$2\" --conditions=source tools/server-scripts/console-auth.ts init-owner --credential-stdin --data-dir \"$3\"", "meshrix-owner-admission", context.layout.currentDirectory, context.nodeExecutable, context.layout.dataDirectory],
    input: serialized,
    allowFailure: true,
  });
  const output: any = String(result?.stdout || "").trim();
  if (result?.status !== 0 || Buffer.byteLength(output, "utf8") > 1024) {
    failNativeOrbBootstrap("native_orb_bootstrap_owner_denied", "Initial owner admission failed.");
  }
  let status: any;
  try { status = JSON.parse(output); } catch { status = null; }
  const statusValid: any = status && typeof status === "object" && !Array.isArray(status) &&
    JSON.stringify(Object.keys(status).sort()) === JSON.stringify(["reason", "status"]) &&
    ((status.status === "created" && status.reason === "initial_owner_created") ||
      (status.status === "already-initialized" && status.reason === "owner_exists"));
  if (!statusValid) {
    failNativeOrbBootstrap("native_orb_bootstrap_owner_status_invalid", "Initial owner returned an invalid status.");
  }
  if (!configExact) {
    await writeExclusiveRemote(context, configTemporary, context.runtimeConfigContents);
    publishExclusiveRemote(context, configTemporary, context.layout.runtimeConfigPath, context.runtimeConfigContents);
  }
  if (!unitExact) {
    await writeExclusiveRemote(context, unitTemporary, context.unitContents);
    publishExclusiveRemote(context, unitTemporary, context.layout.unitPath, context.unitContents);
  }
  context.bootstrapOwnedUnit = true;
  return Object.freeze({ id: "owner", status: status.status === "created" ? "completed" : "resumed" });
}

function remoteFileExact(context?: any, filePath?: unknown, contents?: unknown) : boolean {
  const digest: any = crypto.createHash("sha256").update(String(contents), "utf8").digest("hex");
  const result: any = runOrb({
    machine: context.parsed.machine,
    args: [context.nodeExecutable, "-e", "const fs=require('node:fs'),c=require('node:crypto'),p=process.argv[1],d=process.argv[2];try{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600)process.exit(21);process.exit(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')===d?0:22)}catch(e){process.exit(e.code==='ENOENT'?3:23)}", String(filePath), digest],
    allowFailure: true,
  });
  if (result.status === 0) return true;
  if (result.status === 3) return false;
  failNativeOrbBootstrap("native_orb_bootstrap_configuration_unsafe", "Existing bootstrap configuration is unsafe or mismatched.");
}

async function writeExclusiveRemote(context?: any, filePath?: unknown, contents?: unknown) : Promise<void> {
  const bytes: any = Buffer.from(String(contents), "utf8");
  try {
    const result: any = runOrb({
      machine: context.parsed.machine,
      args: [context.nodeExecutable, "-e", "const fs=require('node:fs');const p=process.argv[1],c=[];let n=0;process.stdin.on('data',b=>{n+=b.length;if(n>65536)process.exit(31);c.push(b)});process.stdin.on('end',()=>fs.writeFileSync(p,Buffer.concat(c,n),{flag:'wx',mode:0o600}))", String(filePath)],
      input: bytes,
      allowFailure: true,
    });
    if (result.status !== 0 && !remoteFileExact(context, filePath, contents)) {
      failNativeOrbBootstrap("native_orb_bootstrap_configuration_unsafe", "Bootstrap configuration staging is unsafe.");
    }
  } finally {
    bytes.fill(0);
  }
}

function publishExclusiveRemote(context?: any, temporaryPath?: unknown, targetPath?: unknown, contents?: unknown) : void {
  const result: any = runOrb({
    machine: context.parsed.machine,
    args: [
      context.nodeExecutable,
      "-e",
      "const fs=require('node:fs');try{fs.linkSync(process.argv[1],process.argv[2]);fs.unlinkSync(process.argv[1])}catch(e){process.exit(e.code==='EEXIST'?17:18)}",
      String(temporaryPath),
      String(targetPath),
    ],
    allowFailure: true,
  });
  if (result.status === 0) return;
  if (result.status === 17 && remoteFileExact(context, targetPath, contents)) {
    runOrb({ machine: context.parsed.machine, args: ["rm", "-f", String(temporaryPath)] });
    return;
  }
  failNativeOrbBootstrap("native_orb_bootstrap_configuration_unsafe", "Bootstrap configuration publication is unsafe.");
}
