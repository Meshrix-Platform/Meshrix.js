import { MemoryArtifactStore } from "@meshrix/gateway";

const artifacts = new MemoryArtifactStore();
const sharedAudience = "tenant-demo/artifact-readers";
const artifact = artifacts.put({ owner: sharedAudience, bytes: new TextEncoder().encode("shared bytes"), contentType: "text/plain" });
console.log(artifacts.head(artifact.id, sharedAudience));
console.log(new TextDecoder().decode(artifacts.read(artifact.id, sharedAudience)));
