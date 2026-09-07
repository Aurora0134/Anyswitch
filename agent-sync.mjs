// Agent config sync coordinator and store file watcher.
//
// When the Anyswitch global store (`%LOCALAPPDATA%\Anyswitch\store.json`) changes
// (e.g. providers/models added, rotated, or deleted via CLI, webUI, or refresh),
// this module automatically updates downstream coding agent configurations
// (ZCode, DSH, Pi, etc.) so agents immediately pick up store mutations
// without requiring manual relay restarts or agent launcher re-invocations.

import { watch, existsSync } from "node:fs";
import { dirname } from "node:path";
import { loadStore, storePaths as defaultStorePaths } from "./store-io.mjs";
import { writeZcodeConfig, zcodeConfigPath } from "./zcode-launcher.mjs";
import { writeDshConfig, dshSettingsPath } from "./dsh-launcher.mjs";
import { writePiModels, piModelsPath } from "./pi-launcher.mjs";
import { writeKimiConfig, kimiConfigPath } from "./kimi-launcher.mjs";
import { writeReasonixConfig, reasonixConfigPath } from "./reasonix-launcher.mjs";
import { writeQoderConfig, qoderSettingsPath } from "./qoder-merge-config.mjs";

/**
 * Synchronize all supported coding agent configurations against the current store.
 *
 * @param {object} options
 * @param {object} [options.store] - Parsed store (if omitted, loaded via loadStore)
 * @param {number} options.port - Relay listening port (e.g. 47821)
 * @param {string} options.token - Relay authentication token
 * @param {string} options.root - Anyswitch root path (%LOCALAPPDATA%\Anyswitch)
 * @param {object} [options.logger] - Logger instance
 * @param {object} [options.base] - Process environment or base paths
 * @returns {Promise<object>} Results of each agent sync
 */
export async function syncAllAgentConfigs({
  store: maybeStore,
  port,
  token,
  root,
  logger = null,
  base = process.env,
}) {
  let store = maybeStore;
  if (!store) {
    const loaded = loadStore(defaultStorePaths(root));
    if (!loaded.ok) {
      logger?.warn?.("syncAllAgentConfigs: store unreadable; skipping agent configs sync");
      return { ok: false, reason: "store-unreadable" };
    }
    store = loaded.store;
  }

  const results = {
    zcode: null,
    dsh: null,
    pi: null,
    kimi: null,
    reasonix: null,
    qoder: null,
  };

  // 1. ZCode config sync (~/.zcode/v2/config.json)
  try {
    const zResult = await writeZcodeConfig(store, port, token, root, zcodeConfigPath(base));
    results.zcode = zResult;
    if (!zResult.ok) {
      logger?.warn?.(`zcode config.json not updated: ${zResult.reason ?? "unknown"}`);
    } else if (!zResult.unchanged) {
      logger?.info?.("zcode config.json synced");
    }
  } catch (err) {
    results.zcode = { ok: false, error: err.message };
    logger?.error?.(`zcode config sync failed: ${err.message}`);
  }

  // 2. DSH settings.yaml sync (~/.dsh/settings.yaml)
  try {
    const dshResult = await writeDshConfig(store, port, root, dshSettingsPath(base));
    results.dsh = dshResult;
    if (!dshResult.ok) {
      logger?.warn?.(`dsh settings.yaml not updated: ${dshResult.reason ?? "unknown"}`);
    } else if (!dshResult.unchanged) {
      logger?.info?.("dsh settings.yaml synced");
    }
  } catch (err) {
    results.dsh = { ok: false, error: err.message };
    logger?.warn?.(`dsh config sync skipped: ${err.message}`);
  }

  // 3. Pi models.json sync (~/.pi/agent/models.json)
  try {
    const piResult = await writePiModels(store, port, root, piModelsPath(base));
    results.pi = piResult;
    if (!piResult.ok) {
      logger?.warn?.(`pi models.json not updated: ${piResult.reason ?? "unknown"}`);
    } else if (!piResult.unchanged) {
      logger?.info?.("pi models.json synced");
    }
  } catch (err) {
    results.pi = { ok: false, error: err.message };
    logger?.warn?.(`pi config sync skipped: ${err.message}`);
  }

  // 4. Kimi Code config.toml sync (~/.kimi-code/config.toml)
  try {
    const kimiResult = await writeKimiConfig(store, port, token, root, kimiConfigPath(base));
    results.kimi = kimiResult;
    if (!kimiResult.ok) {
      logger?.warn?.(`kimi config.toml not updated: ${kimiResult.reason ?? "unknown"}`);
    } else if (!kimiResult.unchanged) {
      logger?.info?.("kimi config.toml synced");
    }
  } catch (err) {
    results.kimi = { ok: false, error: err.message };
    logger?.warn?.(`kimi config sync skipped: ${err.message}`);
  }

  // 5. Reasonix config.toml + .env sync (%APPDATA%\reasonix)
  try {
    const reasonixResult = await writeReasonixConfig(store, port, token, root, reasonixConfigPath(base));
    results.reasonix = reasonixResult;
    if (!reasonixResult.ok) {
      logger?.warn?.(`reasonix config.toml not updated: ${reasonixResult.reason ?? "unknown"}`);
    } else if (!reasonixResult.unchanged) {
      logger?.info?.("reasonix config.toml synced");
    }
  } catch (err) {
    results.reasonix = { ok: false, error: err.message };
    logger?.warn?.(`reasonix config sync skipped: ${err.message}`);
  }

  // 6. Qoder settings.json sync (~/.qoder/settings.json)
  try {
    const qoderResult = await writeQoderConfig(store, port, token, root, qoderSettingsPath(base.USERPROFILE ?? ""));
    results.qoder = qoderResult;
    if (!qoderResult.ok) {
      logger?.warn?.(`qoder settings.json not updated: ${qoderResult.reason ?? "unknown"}`);
    } else if (!qoderResult.unchanged) {
      logger?.info?.("qoder settings.json synced");
    }
  } catch (err) {
    results.qoder = { ok: false, error: err.message };
    logger?.warn?.(`qoder config sync skipped: ${err.message}`);
  }

  return { ok: true, results };
}

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Create a debounced file watcher for store.json that triggers agent sync on store changes.
 *
 * @param {object} options
 * @param {string} options.storeFile - Path to store.json
 * @param {Function} options.onStoreChange - Async callback when store.json changes
 * @param {object} [options.logger] - Logger instance
 * @param {number} [options.debounceMs] - Debounce delay in milliseconds
 * @returns {object} { close: Function, trigger: Function }
 */
export function createStoreWatcher({
  storeFile,
  onStoreChange,
  logger = null,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
  let watcher = null;
  let debounceTimer = null;
  let closed = false;
  let inFlight = false;
  let queued = false;

  async function handleChange() {
    if (closed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      do {
        queued = false;
        try {
          await onStoreChange();
        } catch (err) {
          logger?.error?.(`store watcher change handler error: ${err.message}`);
        }
      } while (queued && !closed);
    } finally {
      inFlight = false;
      if (queued && !closed) {
        handleChange().catch(() => {});
      }
    }
  }

  function scheduleChange() {
    if (closed) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      handleChange().catch(() => {});
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function isStoreRelated(filename) {
    if (!filename) return true;
    const lower = String(filename).toLowerCase();
    if (lower === "store.json" || lower.endsWith("store.json")) return true;
    // atomicWriteFile writes store.json.<uuid>.tmp then renameSync onto store.json.
    // On Windows the directory watcher often reports only the .tmp create/rename,
    // never a filename of exactly "store.json". Treat those siblings as store writes.
    if (lower.startsWith("store.json.") && (lower.endsWith(".tmp") || lower.includes(".tmp."))) return true;
    if (lower.startsWith("store.json.") && lower.endsWith(".tmp")) return true;
    return /\.tmp$/i.test(String(filename)) && /store\.json/i.test(String(filename));
  }

  const watchDir = dirname(storeFile);
  if (existsSync(watchDir)) {
    try {
      watcher = watch(watchDir, { persistent: false }, (eventType, filename) => {
        if (isStoreRelated(filename)) {
          scheduleChange();
        }
      });
      watcher.unref?.();
    } catch (err) {
      logger?.warn?.(`createStoreWatcher: could not watch directory ${watchDir}: ${err.message}`);
    }
  }

  return {
    close() {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
        watcher = null;
      }
    },
    trigger() {
      return handleChange();
    },
  };
}
