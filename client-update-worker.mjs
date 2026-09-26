// Detached installer. Started by the panel with (runId, journalDir) and then
// forgotten: it must keep running after the panel process exits.
import { createEnvironmentService } from "./environment-service.mjs";
import { createReleaseService } from "./release-service.mjs";
import { runClientLifecycle } from "./client-lifecycle.mjs";
import { compareVersions } from "./version-check.mjs";
import { executeClientUpdate, readClientUpdateRun } from "./client-update-journal.mjs";
import { readFileSync } from "node:fs";

const APP_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

const runId = process.argv[2];
const journalDir = process.argv[3];
const recorded = readClientUpdateRun(journalDir, runId);
if (!recorded) process.exit(0);

const environment = createEnvironmentService();
const releases = createReleaseService({ currentVersion: APP_VERSION });

executeClientUpdate({
  runId,
  journalDir,
  runLifecycle: runClientLifecycle,
  environment,
  releases,
  compareVersions,
}).then(
  () => process.exit(0),
  () => process.exit(1),
);
