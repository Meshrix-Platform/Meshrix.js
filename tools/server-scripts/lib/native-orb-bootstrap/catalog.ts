const stage = (id: string, script: string, dependsOn: readonly string[] = []) : any => Object.freeze({
  id,
  script,
  dependsOn: Object.freeze([...dependsOn]),
});

export const NATIVE_ORB_BOOTSTRAP_STAGE_SCRIPTS: readonly any[] = Object.freeze([
  stage("target", "./stages/target.ts"),
  stage("candidate", "./stages/candidate.ts", ["target"]),
  stage("runtime", "./stages/runtime.ts", ["candidate"]),
  stage("install", "./stages/install.ts", ["runtime"]),
  stage("dependencies", "./stages/dependencies.ts", ["install"]),
  stage("build", "./stages/build.ts", ["dependencies"]),
  stage("configure", "./stages/configure.ts", ["build"]),
  stage("owner", "./stages/owner.ts", ["configure"]),
  stage("activate", "./stages/activate.ts", ["owner"]),
  stage("verify", "./stages/verify.ts", ["activate"]),
]);
