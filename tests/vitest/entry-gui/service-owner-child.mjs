import { createServer } from "node:net";
import { createInterface } from "node:readline";

const [moduleUrl, dataDir, mode] = process.argv.slice(2);
try {
  const { acquireEntryServiceOwner } = await import(moduleUrl);
  if (mode === "race") {
    const input = createInterface({ input: process.stdin });
    process.stdout.write("ready\n");
    await new Promise((resolve) => input.once("line", resolve));
    input.close();
  }
  const owner = await acquireEntryServiceOwner(dataDir);
  globalThis.ownerLease = owner;
  await owner.publish(43127, "a".repeat(64));
  if (mode === "hold") {
    const server = createServer();
    globalThis.ownerServer = server;
    server.listen(0, "127.0.0.1", () => process.stdout.write("acquired\n"));
  } else if (mode === "delayed-shutdown") {
    const server = createServer();
    globalThis.ownerServer = server;
    server.listen(0, "127.0.0.1", () => process.stdout.write("acquired\n"));
    const input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
      if (line === "shutdown") process.stdout.write("shutdown-started\n");
      if (line === "finish") {
        input.close();
        server.close(() => {
          process.stdout.write("shutdown-finished\n");
          process.exit(0);
        });
      }
    });
  } else {
    process.stdout.write("acquired\n");
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
  process.stdout.write(`rejected:${String(code)}\n`);
}
