import { rm } from "node:fs/promises";

/**
 * Remove the TypeScript Node build output before compiling.
 *
 * `tsc` never prunes its `outDir`, so deleting or renaming a source module leaves its
 * compiled artifact behind. That residue is then copied into the package `dist`
 * directories by the sync step and can ship inside a package tarball as a module whose
 * source no longer exists. Cleaning the outDir first keeps the build output traceable to
 * the current sources.
 */
await rm("dist", { recursive: true, force: true });
process.stdout.write("cleaned dist\n");
