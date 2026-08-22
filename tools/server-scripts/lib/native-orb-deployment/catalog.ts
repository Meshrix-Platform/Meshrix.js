const stage = (id: string, script: string, dependsOn: readonly string[] = []) : any => Object.freeze({
  id,
  script,
  dependsOn: Object.freeze([...dependsOn]),
});

export const NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS: readonly any[] = Object.freeze([
  stage("runtime", "./stages/runtime.ts"),
  stage("candidate", "./stages/candidate.ts", ["runtime"]),
  stage("transfer", "./stages/transfer.ts", ["candidate"]),
  stage("dependencies", "./stages/dependencies.ts", ["transfer"]),
  stage("build", "./stages/build.ts", ["dependencies"]),
  stage("native-runtime", "./stages/native-runtime.ts", ["build"]),
  stage("configure", "./stages/configure.ts", ["native-runtime"]),
  stage("activate", "./stages/activate.ts", ["configure"]),
  stage("verify", "./stages/verify.ts", ["activate"]),
]);
