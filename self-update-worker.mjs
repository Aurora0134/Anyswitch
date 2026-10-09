// Detached self-updater. Started by the panel with (runId, journalDir) and then
// forgotten: it must keep running after the panel process exits — it is the
// process that replaces the panel's own files and watches the replacement come
// back, so it outlives the thing it is updating by design.
import { runSelfUpdate, SELF_UPDATE_CLIENT_ID } from "./app-self-update.mjs";
import { readClientUpdateRun } from "./client-update-journal.mjs";

const runId = process.argv[2];
const journalDir = process.argv[3];
const recorded = readClientUpdateRun(journalDir, runId);
if (!recorded || recorded.clientId !== SELF_UPDATE_CLIENT_ID) process.exit(0);

runSelfUpdate({ runId, journalDir }).then(
  () => process.exit(0),
  () => process.exit(1),
);
