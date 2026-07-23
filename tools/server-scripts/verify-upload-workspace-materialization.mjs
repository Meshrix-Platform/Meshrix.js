#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { assertNoSensitiveReportLeak, assertReportProvenance, computeVerifierSourceRevision, finalizeSensitiveReport } from "./lib/sensitive-report-scan.mjs";

const root=path.resolve(fileURLToPath(new URL("../..",import.meta.url)));
const verifier="tools/server-scripts/verify-upload-workspace-materialization.mjs";
const reportPath=path.join(root,"build/reports/upload-workspace-materialization.json");
const sha256=(v)=>crypto.createHash("sha256").update(v).digest("hex");
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let verifierStage="startup";

async function main(){
 const startedAt=new Date(); const userDataPath=await fs.mkdtemp(path.join(os.tmpdir(),"lico-upload-materialization-")); let server; let verified=false;
 try{
  verifierStage="server-start";
  server=await startHttpServer({userDataPath,distPath:"",port:0,runtimeOptions:{profile:"minimal"}});
  verifierStage="authentication";
  await installAuthenticatedFetch(server,{safetyConfirm:false});
  const api=async(method,route,body,confirm=true)=>{const response=await fetch(`${server.url}${route}`,{method,headers:{"Content-Type":"application/json",...(confirm?{"x-lico-safety-confirm":"true"}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();return{status:response.status,payload:text?JSON.parse(text):{}}};
  verifierStage="workspace-create";
  const created=await api("POST","/api/agent-workspaces",{title:"Materialization verification",objective:"Verify governed queued materialization."}); assert.equal(created.status,201); const workspaceId=created.payload.workspace.workspaceId;
  verifierStage="workspace-seed";
  const seed=await api("POST",`/api/agent-workspaces/${encodeURIComponent(workspaceId)}/files`,{path:"seed.txt",fileName:"seed.txt",content:"seed"}); verifierStage=`workspace-seed:${seed.status}`; assert.equal(seed.status,201); const expectedWorkspaceRevision=seed.payload.stateCommit.afterRoot;
  verifierStage="upload-session-create";
  const content=Buffer.from("materialized-content"); const session=await api("POST","/api/upload-sessions",{checkpoint:{checkpointId:"materialization-checkpoint"},manifest:{manifestDigest:sha256("manifest"),inputDigest:sha256("input")},files:[{relativePath:"asset.txt",sha256:sha256(content),byteSize:content.length,mediaType:"text/plain"}]}); assert.equal(session.status,200);
  verifierStage="upload-chunk";
  const chunk=await fetch(`${server.url}/api/upload-sessions/${encodeURIComponent(session.payload.sessionId)}/files/0?offset=0`,{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:content}); assert.equal(chunk.status,200);
  const request={
    uploadSessionId:session.payload.sessionId,
    workspaceId,
    expectedWorkspaceRevision,
    mutation:{files:[{sourcePath:session.payload.files[0].relativePath,targetPath:"imports/asset.txt"}]}
  };
  verifierStage="approval-denial";
  const denied=await api("POST","/api/jobs/upload-workspace-materializations",request,false); verifierStage=`approval-denial:${denied.status}`; assert.equal(denied.status,428);
  verifierStage="materialization-admission";
  const admitted=await api("POST","/api/jobs/upload-workspace-materializations",request,true); assert.equal(admitted.status,202); assert.ok(admitted.payload.requestRef);
  verifierStage="materialization-read";
  let read=null; for(let i=0;i<200;i+=1){read=await api("GET",`/api/agent-workspaces/${encodeURIComponent(workspaceId)}/files/download?path=${encodeURIComponent("imports/asset.txt")}&includeText=true`,undefined);if(read.status===200)break;await sleep(25);}
  verifierStage=`materialization-read:${read?.status||0}`;
  assert.equal(read.status,200); assert.equal(read.payload.content,"materialized-content");
  verifierStage="materialization-replay";
  const replay=await api("POST","/api/jobs/upload-workspace-materializations",request,true); assert.equal(replay.status,200); assert.equal(replay.payload.deduped,true);
  verifierStage="report-finalize";
  const finishedAt=new Date(); const provenance={producer:"licomesh-core-upload-workspace-materialization",commandId:"upload-workspace-materialization",sourceRevision:await computeVerifierSourceRevision(root,["packages/server-runtime/src/jobs/upload-workspace-materialization.mjs","packages/server-runtime/src/composition/upload-workspace-materialization-provider.mjs",verifier])};
  const report=finalizeSensitiveReport({schemaVersion:"v0.0.1:jobs:upload-workspace-materialization-report-1",verifier,generatedAt:finishedAt.toISOString(),startedAt:startedAt.toISOString(),finishedAt:finishedAt.toISOString(),ok:true,summary:{verificationPassed:true,productionComposition:true,canonicalQueue:true,canonicalWorkspaceRevision:true,approvalDenialBeforeAdmission:true,idempotentReplayPassed:true,materializedContentVerified:true},checks:[{id:"approval-denial",status:"passed"},{id:"queued-production-admission",status:"passed"},{id:"canonical-workspace-mutation",status:"passed"},{id:"idempotent-replay",status:"passed"}]},{provenance});
  verifierStage="report-privacy";
  assertNoSensitiveReportLeak(report,"upload workspace materialization report");
  verifierStage="report-provenance";
  assertReportProvenance(report,provenance);
  verifierStage="report-write";
  await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`);verified=true;
 }finally{verifierStage=`cleanup:${verifierStage}`;await server?.close?.();await fs.rm(userDataPath,{recursive:true,force:true});}
 if(verified){verifierStage="completed";process.stdout.write(`${JSON.stringify({ok:true,report:"build/reports/upload-workspace-materialization.json"})}\n`);}
}
main().catch((error)=>{
  process.stderr.write(`${JSON.stringify({
    ok:false,
    reason:"upload_workspace_materialization_verification_failed",
    errorCode:String(error?.code||error?.name||"verification_error").slice(0,80),
    stage:verifierStage
  })}\n`);
  process.exitCode=1;
});
