#!/usr/bin/env node
import { packClientAdapters } from "./client-adapter-packages.mjs";
import { sanitizeError } from "./lib/repository.mjs";

packClientAdapters()
  .then((index) => console.log(JSON.stringify({ ok: true, adapterCount: index.packages.length })))
  .catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
