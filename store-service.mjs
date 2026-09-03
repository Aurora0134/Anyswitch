// Panel store-management service: the panel's write-side store flows (the
// read-only store-check diagnostics surface has been retired). Business
// semantics are ported from an early CLI implementation (enroll / discover /
// refresh flows and the delete transaction) onto this repo's store-io /
// dpapi / atomic-write primitives, with store-core.mjs supplying the pure
// planning functions both layers share.
//
// Rules carried over from the CLI:
//   - Every store write is schema-validated and CAS-guarded against the hash
//     that was read. A precondition failure is surfaced as the recognizable
//     error string "cas-conflict".
//   - add is fail-closed: credential file first, then the CAS store write; if
//     the store write fails and the provider is NEW, the orphaned credential
//     file is removed (early CLI enroll semantics).
//   - delete is journal-driven and forward-only: journal pending → CAS store
//     removal → verify → credential file last (the only irreversible step).
//     A broken/unavailable store aborts the whole deletion and retains the
//     credential.
//   - Plaintext keys and ciphertext never appear in any return value.

import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  loadStore as defaultLoadStore,
  writeStore as defaultWriteStore,
  readCiphertext as defaultReadCiphertext,
  resolveCredentialPath as defaultResolveCredentialPath,
  ensureLayout as defaultEnsureLayout,
  storePaths as defaultStorePaths,
} from "./store-io.mjs";
import { protect as defaultProtect, unprotect as defaultUnprotect } from "./dpapi.mjs";
import { atomicWriteFile as defaultAtomicWriteFile } from "./atomic-write.mjs";
import { MAX_CHAIN_NODES, ROUTING_ENDPOINT_IDS } from "./store-schema.mjs";
import { chainNodeKey } from "./chain-routing.mjs";
import {
  buildV2AddEntry,
  computeMigrationSeed,
  effectiveSetChanged,
  materializeModels,
  mergeV2RotateEntry,
  parseBaseURLs,
  planAddModels,
  planRemoveModels,
  planStoreRefresh,
  providerModelsURL,
  sanitizeModelIds,
  validateFilterSave,
  validateProviderId,
} from "./store-core.mjs";

const CAS_CONFLICT = "cas-conflict";

function isCasReason(reason) {
  return typeof reason === "string" && /changed since it was read/.test(reason);
}

function storeWriteError(written, fallback) {
  return isCasReason(written?.reason) ? CAS_CONFLICT : (written?.reason ?? fallback);
}

function safeSanitizeModelIds(values) {
  try {
    return sanitizeModelIds(values);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Delete journal (ported from the early CLI delete transaction)
// ─────────────────────────────────────────────────────────────

function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJournal(journalPath) {
  if (!existsSync(journalPath)) return { pending: [], completed: [] };
  const parsed = JSON.parse(readFileSync(journalPath, "utf8"));
  return {
    pending: Array.isArray(parsed?.pending) ? parsed.pending : [],
    completed: Array.isArray(parsed?.completed) ? parsed.completed : [],
  };
}

function writeJournal(journalPath, journal) {
  if (!existsSync(dirname(journalPath))) throw new Error("delete journal directory is not initialized");
  atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

function markPending(journalPath, providerId, credentialFile) {
  const journal = readJournal(journalPath);
  journal.completed = journal.completed.filter((entry) => entry.providerId !== providerId);
  if (journal.pending.some((entry) => entry.providerId === providerId)) {
    writeJournal(journalPath, journal);
    return;
  }
  journal.pending.push({ providerId, credentialFile, recordedAt: new Date().toISOString() });
  writeJournal(journalPath, journal);
}

function clearPending(journalPath, providerId, credentialFile) {
  const journal = readJournal(journalPath);
  const next = {
    pending: journal.pending.filter((entry) => entry.providerId !== providerId),
    completed: journal.completed.some((entry) => entry.providerId === providerId)
      ? journal.completed
      : [...journal.completed, { providerId, credentialFile, completedAt: new Date().toISOString() }],
  };
  writeJournal(journalPath, next);
}

function findPending(journalPath, providerId) {
  return readJournal(journalPath).pending.find((entry) => entry.providerId === providerId);
}

function findCompleted(journalPath, providerId) {
  return readJournal(journalPath).completed.find((entry) => entry.providerId === providerId);
}

/**
 * Store-management service for the panel router. All IO is injectable so the
 * service is unit-testable against a mkdtemp store root with fake fetch/dpapi;
 * the defaults hit the real store-io/dpapi modules.
 */
export function createStoreService({
  paths = defaultStorePaths(),
  loadStore = (p) => defaultLoadStore(p),
  writeStore = (store, options) => defaultWriteStore(store, options),
  readCiphertext = (credentialFile, p) => defaultReadCiphertext(credentialFile, p),
  resolveCredentialPath = (credentialFile, p) => defaultResolveCredentialPath(credentialFile, p),
  ensureLayout = (p) => defaultEnsureLayout(p),
  atomicWriteFile = defaultAtomicWriteFile,
  protect = (plaintext, providerId) => defaultProtect(plaintext, providerId, { generation: "v2" }),
  unprotect = (ciphertext, providerId) => defaultUnprotect(ciphertext, providerId, { generation: "v2" }),
  fetchImpl = fetch,
  journalPath = join(paths.root, "delete-journal.json"),
  fsOps = { exists: existsSync, lstat: lstatSync, remove: (path) => rmSync(path, { force: true }) },
} = {}) {
  const load = () => loadStore(paths);
  const write = (store, options) => writeStore(store, { paths, ...options });

  // Ported from the early CLI model discovery: GET <baseURL>/models with a 30s
  // timeout, capturing the verified upstream field names (context_length /
  // max_completion_tokens). Reasoning fields are deliberately NOT collected:
  // no upstream in the field returns supports_reasoning / reasoning_effort_levels
  // (audited 2026-09-01, all providers HTTP 200), so extraction only ever
  // produced empty metadata; the effort selector is fed from store annotations
  // and the pi-ai knowledge base instead (reasoning-fallback.mjs).
  async function discoverModels(baseURL, plaintext) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      let response;
      try {
        response = await fetchImpl(providerModelsURL(baseURL), {
          headers: { Authorization: `Bearer ${plaintext.toString("utf8")}` },
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === "AbortError") throw new Error("model discovery timed out after 30 seconds");
        throw new Error("model discovery request failed; check the network, proxy, TLS, and API endpoint");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`model discovery failed with HTTP ${response.status}`);
      }
      const payload = await response.json();
      const rawModels = Array.isArray(payload?.data)
        ? payload.data
            .filter((m) => m && typeof m.id === "string")
            .map((m) => {
              const entry = { id: m.id };
              const contextWindow = m.context_length ?? m.context_window ?? m.contextWindow;
              if (contextWindow !== undefined) entry.contextWindow = contextWindow;
              const maxOutputTokens = m.max_completion_tokens ?? m.max_output_tokens ?? m.maxOutputTokens;
              if (maxOutputTokens !== undefined) entry.maxOutputTokens = maxOutputTokens;
              return entry;
            })
        : [];
      const rawIds = rawModels.map((m) => m.id);
      return { rawIds, rawModels, sanitizedIds: safeSanitizeModelIds(rawIds) };
    } finally {
      clearTimeout(timer);
    }
  }

  // One idempotent forward-only provider deletion (ported from the early CLI
  // delete transaction). Throws on any failure; the
  // caller (deleteProvider / resumeDeletions) converts to a result object.
  async function deleteProviderOnce(providerId) {
    validateProviderId(providerId);

    // Membership comes from the v2 store. A load failure is fail-closed.
    const loaded = load();
    if (!loaded.ok) {
      throw new Error(`the Anyswitch v2 store is unavailable: ${loaded.reason}; deletion aborted, credential retained`);
    }
    const v2Providers = loaded.store.providers ?? {};
    const managedEntry = Object.hasOwn(v2Providers, providerId) ? v2Providers[providerId] : undefined;

    const credentialFile = `${providerId}.dpapi`;
    const modelCount = managedEntry ? Object.keys(managedEntry.models ?? {}).length : 0;

    if (!managedEntry) {
      const pending = findPending(journalPath, providerId);
      if (!pending) {
        if (findCompleted(journalPath, providerId)) return { deleted: true, alreadyDeleted: true };
        throw new Error(`Provider ${providerId} is not managed by Anyswitch`);
      }
    }

    // Pools keep ordered references to their members; a pooled provider must
    // not be deleted out from under its pool (the schema would reject the
    // dangling reference on the next load anyway). The panel dissolves the
    // pool first (pool/delete) and only then deletes the members.
    // This gate MUST run before markPending: it is a business rejection, not
    // a transient failure — a pending journal entry left behind would be
    // replayed by resumeDeletions once the pool is gone, deleting the
    // provider out from under the user (learned the hard way: a blocked
    // negative test deleted the live sensenova entry + credential).
    if (managedEntry) {
      const pools = loaded.store.pools ?? {};
      for (const [poolId, pool] of Object.entries(pools)) {
        if (Array.isArray(pool?.members) && pool.members.includes(providerId)) {
          throw new Error(`Provider ${providerId} belongs to pool "${poolId}"; dissolve the pool first`);
        }
      }
    }

    markPending(journalPath, providerId, credentialFile);

    // Step 1: remove the store entry with a CAS guard. Fail-closed: a write
    // failure throws before the credential is removed.
    if (managedEntry) {
      const nextV2Providers = { ...v2Providers };
      delete nextV2Providers[providerId];
      const nextV2Store = { ...loaded.store, version: 2, providers: nextV2Providers };
      const written = write(nextV2Store, { expectedHash: loaded.hash });
      if (!written.ok) {
        throw new Error(`the Anyswitch v2 store was not updated for ${providerId}: ${written.reason}; deletion aborted, credential retained`);
      }
    }

    // Step 2: verify the store no longer references the provider before the
    // irreversible credential removal.
    const reloaded = load();
    const finalV2Present = reloaded.ok && Object.hasOwn(reloaded.store.providers ?? {}, providerId);
    if (finalV2Present) {
      throw new Error(`Provider ${providerId} deletion could not be verified; credential was retained`);
    }

    // Step 3 (irreversible, last): remove the DPAPI credential file, resolved
    // under the fixed credentials root, refusing a symlink / non-file.
    const resolved = resolveCredentialPath(credentialFile, paths);
    if (resolved.ok) {
      const credentialPath = resolved.path;
      if (fsOps.exists(credentialPath)) {
        let credentialStat;
        try {
          credentialStat = fsOps.lstat(credentialPath);
        } catch {
          throw new Error(`Credential path could not be inspected for ${providerId}; credential was retained`);
        }
        if (!credentialStat.isFile() || credentialStat.isSymbolicLink()) {
          throw new Error(`Credential path is unsafe for ${providerId}; credential was retained`);
        }
        fsOps.remove(credentialPath);
      }
    }

    clearPending(journalPath, providerId, credentialFile);

    return { deleted: true, modelCount, credentialFile };
  }

  // Re-runs the same idempotent deletion for every provider still pending in
  // the journal (ported from resumeIncompleteDeletions).
  async function resumeDeletions() {
    const journal = readJournal(journalPath);
    const resumed = [];
    const failed = [];
    for (const entry of journal.pending) {
      try {
        await deleteProviderOnce(entry.providerId);
        resumed.push(entry.providerId);
      } catch (error) {
        failed.push({ providerId: entry.providerId, reason: error instanceof Error ? error.message : "unknown error" });
      }
    }
    return { resumed, failed };
  }

  async function readPlaintextCredential(providerId, credentialFile) {
    const read = readCiphertext(credentialFile, paths);
    if (!read.ok) return { ok: false, error: `credential unavailable for ${providerId}: ${read.reason}` };
    const ciphertext = read.ciphertext;
    try {
      const plaintext = await unprotect(ciphertext, providerId);
      return { ok: true, plaintext };
    } catch {
      return { ok: false, error: `credential could not be decrypted for ${providerId}` };
    } finally {
      ciphertext?.fill?.(0);
    }
  }

  return {
    discoverModels,

    /**
     * Lightweight read for the board view's route-chain rail: routingChains
     * (same enabled 口径 as getState — absent means enabled) + provider/pool
     * id→displayName maps only; no models/discovered/modelFilter payloads.
     * Always ok:true, with a degraded shape when the store is unreadable.
     * resumeDeletions is triggered fire-and-forget — not awaited, never in the
     * response — so interrupted deletions still resume without this endpoint
     * paying delete-journal IO on the board's polling path.
     */
    async getBoardState() {
      void resumeDeletions().catch(() => {}); // fire-and-forget, 不进响应
      const loaded = load();
      if (!loaded.ok) {
        return { ok: true, storeOk: false, storeError: loaded.reason, routingChains: [], providerNames: {}, poolNames: {} };
      }
      const routingChains = Object.entries(loaded.store.routingChains ?? {}).map(([endpointId, entry]) => ({
        endpointId,
        chain: Array.isArray(entry?.chain) ? entry.chain : [],
        // 与 getState 同口径：store 里 absent = 开，向后兼容存量链。
        enabled: entry?.enabled !== false,
      }));
      const providerNames = {};
      for (const [id, entry] of Object.entries(loaded.store.providers ?? {})) {
        providerNames[id] = entry.displayName ?? id;
      }
      const poolNames = {};
      for (const [id, pool] of Object.entries(loaded.store.pools ?? {})) {
        poolNames[id] = pool.displayName ?? id;
      }
      return { ok: true, storeOk: true, hash: loaded.hash, routingChains, providerNames, poolNames };
    },

    /** Aggregate everything the store tab renders; resumes pending deletions. */
    async getState() {
      let resumeResult;
      try {
        resumeResult = await resumeDeletions();
      } catch {
        resumeResult = { resumed: [], failed: [], error: "could not inspect the delete journal" };
      }
      const loaded = load();
      if (!loaded.ok) {
        return { ok: true, storeOk: false, hash: null, storeError: loaded.reason, providers: [], pools: [], routingChains: [], resumeResult };
      }
      const rawPools = loaded.store.pools ?? {};
      // providerId -> poolId, for the panel's pool tag / delete gate.
      const membership = new Map();
      for (const [poolId, pool] of Object.entries(rawPools)) {
        for (const memberId of pool.members ?? []) membership.set(memberId, poolId);
      }
      const providers = Object.entries(loaded.store.providers ?? {}).map(([id, entry]) => {
        const resolved = resolveCredentialPath(`${id}.dpapi`, paths);
        return {
          id,
          displayName: entry.displayName ?? id,
          baseURL: entry.baseURL,
          fallbackURLs: Array.isArray(entry.fallbackURLs) ? entry.fallbackURLs : [],
          modelCount: Object.keys(entry.models ?? {}).length,
          discoveredCount: Object.keys(entry.discovered ?? {}).length,
          filterCount: Array.isArray(entry.modelFilter) ? entry.modelFilter.length : null,
          hasCredential: resolved.ok ? existsSync(resolved.path) : false,
          poolId: membership.get(id) ?? null,
          // Full entry payloads for the filter editor. The store schema
          // forbids secret-bearing fields, so these objects carry no keys.
          models: entry.models ?? {},
          discovered: entry.discovered ?? {},
          modelFilter: Array.isArray(entry.modelFilter) ? entry.modelFilter : null,
        };
      });
      const pools = Object.entries(rawPools).map(([id, pool]) => ({
        id,
        displayName: pool.displayName ?? id,
        members: Array.isArray(pool.members) ? pool.members : [],
      }));
      const routingChains = Object.entries(loaded.store.routingChains ?? {}).map(([endpointId, entry]) => ({
        endpointId,
        chain: Array.isArray(entry?.chain) ? entry.chain : [],
        // per-endpoint 自动路由启用开关：显式下发布尔，前端不用猜缺省
        //（store 里 absent = 开，向后兼容存量链）。
        enabled: entry?.enabled !== false,
      }));
      return { ok: true, storeOk: true, hash: loaded.hash, providers, pools, routingChains, resumeResult };
    },

    /** Verify a managed provider's credential against its live /models. */
    async testProvider(id) {
      try {
        validateProviderId(id);
      } catch (error) {
        return { ok: false, error: error.message };
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const entry = loaded.store.providers?.[id];
      if (!entry) return { ok: false, error: `Provider ${id} is not managed by Anyswitch` };
      const credential = await readPlaintextCredential(id, entry.credentialFile ?? `${id}.dpapi`);
      if (!credential.ok) return { ok: false, error: credential.error };
      const plaintext = credential.plaintext;
      try {
        const discovered = await discoverModels(entry.baseURL, plaintext);
        return { ok: true, modelCount: discovered.sanitizedIds.length };
      } catch (error) {
        return { ok: false, error: error.message };
      } finally {
        plaintext?.fill?.(0);
      }
    },

    /**
     * Add a new provider: validate → discover (manual modelIds as fallback) →
     * buildV2AddEntry → DPAPI credential write → CAS store write. Fail-closed:
     * if the store write fails for a NEW provider, the orphaned credential
     * file is removed (early CLI enroll semantics).
     */
    async addProvider({ id, displayName, baseURLs, apiKey, modelIds }) {
      try {
        validateProviderId(id);
      } catch (error) {
        return { ok: false, error: error.message };
      }
      let parsed;
      try {
        parsed = parseBaseURLs(baseURLs);
      } catch (error) {
        return { ok: false, error: error.message };
      }
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        return { ok: false, error: "apiKey must be a non-empty string" };
      }
      const loaded = load();
      if (!loaded.ok && loaded.reason !== "store-absent") {
        return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      }
      const store = loaded.ok ? loaded.store : { version: 2, providers: {} };
      const expectedHash = loaded.ok ? loaded.hash : null;
      if (store.providers?.[id]) return { ok: false, error: `Provider ${id} already exists` };

      const plaintext = Buffer.from(apiKey, "utf8");
      let ciphertext;
      let credentialWritten = false;
      let credentialPath = null;
      try {
        let ids;
        try {
          const discovered = await discoverModels(parsed.baseURL, plaintext);
          ids = discovered.sanitizedIds;
          if (!ids.length) throw new Error("Provider returned no usable model IDs");
        } catch (discoveryError) {
          if (!Array.isArray(modelIds) || modelIds.length === 0) {
            return { ok: false, error: `${discoveryError.message}; provide modelIds to add without discovery` };
          }
          try {
            ids = sanitizeModelIds(modelIds);
          } catch (sanitizeError) {
            return { ok: false, error: sanitizeError.message };
          }
        }

        const entry = buildV2AddEntry({
          displayName: typeof displayName === "string" && displayName.trim() ? displayName.trim() : id,
          baseURL: parsed.baseURL,
          fallbackURLs: parsed.fallbackURLs,
          credentialFile: `${id}.dpapi`,
          modelIds: ids,
        });

        ciphertext = await protect(plaintext, id);
        ensureLayout(paths);
        const resolved = resolveCredentialPath(`${id}.dpapi`, paths);
        if (!resolved.ok) return { ok: false, error: `refusing to write the credential: ${resolved.reason}` };
        credentialPath = resolved.path;
        atomicWriteFile(credentialPath, ciphertext);
        credentialWritten = true;

        const nextStore = structuredClone(store);
        nextStore.providers[id] = entry;
        const written = write(nextStore, { expectedHash });
        if (!written.ok) {
          // Fail-closed cleanup only because this provider is NEW: the freshly
          // written credential is a true orphan and must be removed.
          if (credentialWritten && credentialPath) fsOps.remove(credentialPath);
          credentialWritten = false;
          return { ok: false, error: storeWriteError(written, "store write failed") };
        }
        return { ok: true, id, modelCount: ids.length };
      } catch (error) {
        if (credentialWritten && credentialPath) {
          try {
            fsOps.remove(credentialPath);
          } catch {
            /* best-effort orphan cleanup */
          }
        }
        return { ok: false, error: error.message };
      } finally {
        plaintext.fill(0);
        ciphertext?.fill?.(0);
      }
    },

    /**
     * Rotate an existing provider. baseURLs omitted/empty keeps the existing
     * URL group; the built-in `opencode` provider's endpoint cannot be
     * changed. mergeV2RotateEntry preserves discovered/modelFilter/models.
     * The credential file is rewritten only when a new apiKey is given, and a
     * store-write failure never removes it (the provider already existed).
     */
    async rotateProvider({ id, apiKey, baseURLs }) {
      try {
        validateProviderId(id);
      } catch (error) {
        return { ok: false, error: error.message };
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const existing = loaded.store.providers?.[id];
      if (!existing) return { ok: false, error: `Provider ${id} is not managed by Anyswitch` };

      let baseURL = existing.baseURL;
      let fallbackURLs; // undefined keeps the existing group
      if (typeof baseURLs === "string" && baseURLs.trim()) {
        if (id === "opencode") {
          return { ok: false, error: "The built-in opencode provider endpoint cannot be changed by Anyswitch" };
        }
        try {
          const parsed = parseBaseURLs(baseURLs);
          baseURL = parsed.baseURL;
          if (parsed.fallbackURLs !== undefined) fallbackURLs = parsed.fallbackURLs;
        } catch (error) {
          return { ok: false, error: error.message };
        }
      }
      const hasNewKey = typeof apiKey === "string" && apiKey.length > 0;
      if (!hasNewKey && fallbackURLs === undefined && baseURL === existing.baseURL) {
        return { ok: false, error: "nothing to rotate: provide an apiKey and/or baseURLs" };
      }

      const entry = mergeV2RotateEntry({
        existing,
        baseURL,
        ...(fallbackURLs !== undefined ? { fallbackURLs } : {}),
        credentialFile: existing.credentialFile ?? `${id}.dpapi`,
      });

      let plaintext;
      let ciphertext;
      try {
        if (hasNewKey) {
          plaintext = Buffer.from(apiKey, "utf8");
          ciphertext = await protect(plaintext, id);
          ensureLayout(paths);
          const resolved = resolveCredentialPath(entry.credentialFile, paths);
          if (!resolved.ok) return { ok: false, error: `refusing to write the credential: ${resolved.reason}` };
          atomicWriteFile(resolved.path, ciphertext);
        }
        const nextStore = structuredClone(loaded.store);
        nextStore.providers[id] = entry;
        const written = write(nextStore, { expectedHash: loaded.hash });
        if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
        return { ok: true, id };
      } catch (error) {
        return { ok: false, error: error.message };
      } finally {
        plaintext?.fill?.(0);
        ciphertext?.fill?.(0);
      }
    },

    /**
     * Re-discover models for one or all providers (skipping the built-in
     * `opencode`). A single provider's failure never interrupts the batch.
     * The store is written only when something actually changed.
     */
    async refreshProviders(id) {
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store could not be loaded: ${loaded.reason}` };
      const store = loaded.store;
      const allProviderIds = Object.keys(store.providers ?? {});
      let targets;
      if (id) {
        try {
          validateProviderId(id);
        } catch (error) {
          return { ok: false, error: error.message };
        }
        if (!allProviderIds.includes(id)) {
          return { ok: false, error: `Provider ${id} is not present in the Anyswitch v2 store` };
        }
        targets = [id];
      } else {
        targets = allProviderIds.filter((providerId) => providerId !== "opencode");
      }

      const discoveries = [];
      for (const providerId of targets) {
        const entry = store.providers[providerId];
        try {
          const credential = await readPlaintextCredential(providerId, entry.credentialFile ?? `${providerId}.dpapi`);
          if (!credential.ok) throw new Error(credential.error);
          const plaintext = credential.plaintext;
          try {
            const discovered = await discoverModels(entry.baseURL, plaintext);
            discoveries.push({
              providerId,
              rawIds: discovered.rawIds,
              sanitizedIds: discovered.sanitizedIds,
              rawModels: discovered.rawModels,
            });
          } finally {
            plaintext?.fill?.(0);
          }
        } catch (error) {
          discoveries.push({ providerId, error: error.message });
        }
      }

      // The panel has no opencode.jsonc to seed a lazy migration from; the
      // store is the single source of truth, so the seed comes from the
      // provider's existing store models (config side stays empty).
      const plan = planStoreRefresh({ configText: "{}", store, discoveries });
      const storeChanged = JSON.stringify(plan.store) !== JSON.stringify(store);
      if (storeChanged) {
        const written = write(plan.store, { expectedHash: loaded.hash });
        if (!written.ok) {
          return { ok: false, error: storeWriteError(written, "store write failed"), reports: plan.reports };
        }
      }
      return {
        ok: true,
        reports: plan.reports,
        anyFailed: plan.reports.some((report) => report.status === "failed"),
      };
    },

    /**
     * Save the user-curated model allow-list. Uses the discovered cache only
     * (no network discovery); an empty cache means "refresh first". A legacy
     * entry without discovered/modelFilter is lazily migrated. When the
     * effective set does not change and no migration happened, this is a
     * no-op with no store write.
     */
    async saveFilter({ id, modelFilter }) {
      try {
        validateProviderId(id);
      } catch (error) {
        return { ok: false, error: error.message };
      }
      if (!Array.isArray(modelFilter)) return { ok: false, error: "modelFilter must be an array of model IDs" };
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const entry = loaded.store.providers?.[id];
      if (!entry) return { ok: false, error: `Provider ${id} is not managed by Anyswitch` };

      const nextEntry = structuredClone(entry);
      let seeded = false;
      if (
        !nextEntry.discovered ||
        typeof nextEntry.discovered !== "object" ||
        Array.isArray(nextEntry.discovered) ||
        !Array.isArray(nextEntry.modelFilter)
      ) {
        const seed = computeMigrationSeed({ storeModels: nextEntry.models });
        if (!nextEntry.discovered || typeof nextEntry.discovered !== "object" || Array.isArray(nextEntry.discovered)) {
          nextEntry.discovered = seed.discovered;
        }
        if (!Array.isArray(nextEntry.modelFilter)) nextEntry.modelFilter = seed.modelFilter;
        seeded = true;
      }

      const check = validateFilterSave({ discovered: nextEntry.discovered, modelFilter });
      if (!check.ok) {
        return {
          ok: false,
          error: check.reason === "no-discovered"
            ? `no discovered models for ${id}; run refresh first`
            : `the filter enables no discovered model for ${id}`,
        };
      }

      const before = materializeModels({
        discovered: nextEntry.discovered,
        modelFilter: nextEntry.modelFilter,
        configModels: {},
      });
      const after = materializeModels({
        discovered: nextEntry.discovered,
        modelFilter,
        configModels: {},
      });
      if (!seeded && !effectiveSetChanged({ before: before.effective, after: after.effective })) {
        return { ok: true, noop: true, effective: after.effective };
      }

      nextEntry.modelFilter = modelFilter.filter((modelId) => typeof modelId === "string");
      nextEntry.models = after.storeModels;
      const nextStore = structuredClone(loaded.store);
      nextStore.providers[id] = nextEntry;
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, effective: after.effective };
    },

    /**
     * Manually add model ids the upstream /models listing failed to report.
     * planAddModels does the pure work (lazy migration, duplicate rejection,
     * manual:true tagging so refresh never prunes them); this wrapper loads,
     * CAS-writes, and reports. Failures carry { ok:false, reason } so the
     * route can map them to messages; a lost CAS race is reason
     * "cas-conflict".
     */
    async addModels(providerId, modelIds) {
      const loaded = load();
      if (!loaded.ok) return { ok: false, reason: "store-unavailable", error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const entry = loaded.store.providers?.[providerId];
      if (!entry) return { ok: false, reason: "unknown-provider" };

      const plan = planAddModels(entry, modelIds);
      if (!plan.ok) return plan;

      const nextStore = structuredClone(loaded.store);
      nextStore.providers[providerId] = plan.nextEntry;
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, reason: storeWriteError(written, "store write failed") };
      return { ok: true, added: plan.added, models: Object.keys(plan.nextEntry.models) };
    },

    /**
     * Remove model ids (manual backfills and probe-discovered alike).
     * planRemoveModels does the pure work (lazy migration, wholesale
     * model-not-found rejection); this wrapper loads, CAS-writes, and
     * reports. Failures carry { ok:false, reason } so the route can map
     * them to messages; a lost CAS race is reason "cas-conflict".
     */
    async removeModels(providerId, modelIds) {
      const loaded = load();
      if (!loaded.ok) return { ok: false, reason: "store-unavailable", error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const entry = loaded.store.providers?.[providerId];
      if (!entry) return { ok: false, reason: "unknown-provider" };

      const plan = planRemoveModels(entry, modelIds);
      if (!plan.ok) return plan;

      const nextStore = structuredClone(loaded.store);
      nextStore.providers[providerId] = plan.nextEntry;
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, reason: storeWriteError(written, "store write failed") };
      return { ok: true, removed: plan.removed, models: Object.keys(plan.nextEntry.models) };
    },

    /**
     * Create a provider pool (号池). Pure membership bookkeeping —
     * no credential, no network: validate the id against the shared provider
     * id rules, require 2-5 existing un-pooled providers, then CAS-write the
     * top-level `pools` map.
     */
    async createPool({ poolId, displayName, members }) {
      try {
        validateProviderId(poolId);
      } catch (error) {
        return { ok: false, error: `pool id: ${error.message}` };
      }
      if (typeof displayName !== "string" || displayName.trim().length === 0) {
        return { ok: false, error: "pool displayName must be a non-empty string" };
      }
      if (!Array.isArray(members) || members.some((m) => typeof m !== "string" || m.length === 0)) {
        return { ok: false, error: "pool members must be an array of provider ids" };
      }
      if (members.length < 2 || members.length > 5) {
        return { ok: false, error: `一个号池最多联立 5 个渠道（至少 2 个）；当前 ${members.length} 个` };
      }
      if (new Set(members).size !== members.length) {
        return { ok: false, error: "pool members contain duplicates" };
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const providers = loaded.store.providers ?? {};
      const memberIdSet = new Set(members);
      // A pool may reuse the id of one of its own members; colliding with a
      // non-member provider (even only by case) is an error.
      if (Object.hasOwn(providers, poolId) && !memberIdSet.has(poolId)) {
        return { ok: false, error: `pool id "${poolId}" collides with an existing provider id` };
      }
      for (const id of Object.keys(providers)) {
        if (id.toLowerCase() === poolId.toLowerCase() && id !== poolId && !memberIdSet.has(id)) {
          return { ok: false, error: `pool id "${poolId}" differs only by case from provider "${id}"` };
        }
      }
      const pools = loaded.store.pools ?? {};
      if (Object.hasOwn(pools, poolId)) {
        return { ok: false, error: `pool "${poolId}" already exists` };
      }
      for (const memberId of members) {
        if (!Object.hasOwn(providers, memberId)) {
          return { ok: false, error: `Provider ${memberId} is not managed by Anyswitch` };
        }
        if (memberId === "opencode") {
          return { ok: false, error: `the built-in opencode provider cannot join a pool` };
        }
      }
      for (const [otherPoolId, pool] of Object.entries(pools)) {
        for (const memberId of members) {
          if (Array.isArray(pool?.members) && pool.members.includes(memberId)) {
            return { ok: false, error: `Provider ${memberId} already belongs to pool "${otherPoolId}"` };
          }
        }
      }
      const nextStore = structuredClone(loaded.store);
      nextStore.pools = { ...pools, [poolId]: { displayName: displayName.trim(), members: [...members] } };
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, poolId };
    },

    /**
     * Replace a pool's member list wholesale — "add to existing pool" and
     * "reorder members" share this entry point; `members` is the full ordered
     * replacement. Same validation as createPool with one difference: members
     * already in THIS pool are allowed (other pools still reject). The
     * displayName is untouched; a lost CAS race reports error "cas-conflict".
     */
    async updatePoolMembers({ poolId, members }) {
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const pools = loaded.store.pools ?? {};
      const pool = pools[poolId];
      if (!pool) return { ok: false, error: `pool "${poolId}" does not exist` };
      if (!Array.isArray(members) || members.some((m) => typeof m !== "string" || m.length === 0)) {
        return { ok: false, error: "pool members must be an array of provider ids" };
      }
      if (members.length < 2 || members.length > 5) {
        return { ok: false, error: `一个号池最多联立 5 个渠道（至少 2 个）；当前 ${members.length} 个` };
      }
      if (new Set(members).size !== members.length) {
        return { ok: false, error: "pool members contain duplicates" };
      }
      const providers = loaded.store.providers ?? {};
      for (const memberId of members) {
        if (!Object.hasOwn(providers, memberId)) {
          return { ok: false, error: `Provider ${memberId} is not managed by Anyswitch` };
        }
        if (memberId === "opencode") {
          return { ok: false, error: `the built-in opencode provider cannot join a pool` };
        }
      }
      for (const [otherPoolId, otherPool] of Object.entries(pools)) {
        if (otherPoolId === poolId) continue;
        for (const memberId of members) {
          if (Array.isArray(otherPool?.members) && otherPool.members.includes(memberId)) {
            return { ok: false, error: `Provider ${memberId} already belongs to pool "${otherPoolId}"` };
          }
        }
      }
      const nextStore = structuredClone(loaded.store);
      nextStore.pools[poolId].members = [...members];
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, poolId };
    },

    /**
     * Dissolve a pool: drop the pools entry only; member providers and their
     * credentials are untouched (they return to independent-provider state).
     */
    async deletePool(poolId) {
      try {
        validateProviderId(poolId);
      } catch (error) {
        return { ok: false, error: `pool id: ${error.message}` };
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const pools = loaded.store.pools ?? {};
      if (!Object.hasOwn(pools, poolId)) {
        return { ok: false, error: `pool "${poolId}" does not exist` };
      }
      const nextStore = structuredClone(loaded.store);
      delete nextStore.pools[poolId];
      if (Object.keys(nextStore.pools).length === 0) delete nextStore.pools;
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, poolId };
    },

    /**
     * Save an endpoint's route chain (自动路由): `chain` is the full ordered
     * replacement — an array of { node, model } entries where node names a
     * provider OR a pool (resolution checks pools first, same as the relay)
     * and model is the concrete upstream model that node is asked for. The
     * bound model is NOT validated against the node's catalog: catalogs shift
     * with discovered refreshes, so a hard check would break saved chains.
     * Pure bookkeeping like the pool methods: validate input before loading,
     * then structuredClone → CAS write; a lost race reports "cas-conflict".
     */
    async saveRouteChain(endpointId, chain) {
      if (!ROUTING_ENDPOINT_IDS.includes(endpointId)) {
        return { ok: false, error: `unknown endpoint id "${endpointId}" (known: ${ROUTING_ENDPOINT_IDS.join(", ")})` };
      }
      if (!Array.isArray(chain) || chain.length === 0) {
        return { ok: false, error: "route chain must be a non-empty array of { node, model } entries" };
      }
      if (chain.length > MAX_CHAIN_NODES) {
        return { ok: false, error: `一条路由链最多 ${MAX_CHAIN_NODES} 个节点；当前 ${chain.length} 个` };
      }
      const seenPairs = new Set();
      for (const item of chain) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          return { ok: false, error: "route chain entries must be objects { node, model }" };
        }
        const { node, model } = item;
        if (typeof node !== "string" || node.length === 0) {
          return { ok: false, error: "route chain entry node must be a non-empty string" };
        }
        try {
          validateProviderId(node);
        } catch (error) {
          return { ok: false, error: `route chain node "${node}": ${error.message}` };
        }
        if (typeof model !== "string" || model.trim().length === 0) {
          return { ok: false, error: `route chain entry for node "${node}": model must be a non-empty string` };
        }
        // 与 store-schema 一致按 node+model 复合键去重：同节点不同模型可多次入链。
        const pairKey = chainNodeKey(node, model);
        if (seenPairs.has(pairKey)) {
          return { ok: false, error: `route chain contains duplicate node "${node}" with model "${model}"` };
        }
        seenPairs.add(pairKey);
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const providers = loaded.store.providers ?? {};
      const pools = loaded.store.pools ?? {};
      for (const item of chain) {
        if (!Object.hasOwn(providers, item.node) && !Object.hasOwn(pools, item.node)) {
          return { ok: false, error: `route chain node "${item.node}" is neither a managed provider nor a pool` };
        }
      }
      const nextStore = structuredClone(loaded.store);
      // 保留既有 enabled 开关标志：重存链（编辑器保存）不把开关弹回开。
      const prevEnabled = loaded.store.routingChains?.[endpointId]?.enabled;
      nextStore.routingChains = {
        ...(loaded.store.routingChains ?? {}),
        [endpointId]: {
          chain: chain.map((item) => ({ node: item.node, model: item.model })),
          ...(typeof prevEnabled === "boolean" ? { enabled: prevEnabled } : {}),
        },
      };
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, endpointId };
    },

    /**
     * Flip an endpoint's 自动路由 switch (per-endpoint enabled flag on the
     * routingChains entry). Off keeps the chain config but stops exposing and
     * serving the virtual model "auto" (resolveChain short-circuits, the
     * `_auto` pseudo-channel leaves the synced agent configs, and the panel's
     * Flow Rail runtime view drops the endpoint). Requires an existing chain:
     * the toggle lives on the chain card, not on unconfigured endpoints.
     */
    async setRouteChainEnabled(endpointId, enabled) {
      if (!ROUTING_ENDPOINT_IDS.includes(endpointId)) {
        return { ok: false, error: `unknown endpoint id "${endpointId}" (known: ${ROUTING_ENDPOINT_IDS.join(", ")})` };
      }
      if (typeof enabled !== "boolean") {
        return { ok: false, error: "enabled must be a boolean" };
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const entry = loaded.store.routingChains?.[endpointId];
      if (!entry || !Array.isArray(entry.chain)) {
        return { ok: false, error: `route chain for endpoint "${endpointId}" does not exist` };
      }
      const nextStore = structuredClone(loaded.store);
      nextStore.routingChains[endpointId] = { ...entry, enabled };
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, endpointId, enabled };
    },

    /**
     * Remove an endpoint's route chain: drop the routingChains entry only;
     * providers and pools are untouched. No journal — there is no credential
     * or other irreversible step involved.
     */
    async deleteRouteChain(endpointId) {
      if (!ROUTING_ENDPOINT_IDS.includes(endpointId)) {
        return { ok: false, error: `unknown endpoint id "${endpointId}" (known: ${ROUTING_ENDPOINT_IDS.join(", ")})` };
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const routingChains = loaded.store.routingChains ?? {};
      if (!Object.hasOwn(routingChains, endpointId)) {
        return { ok: false, error: `route chain for endpoint "${endpointId}" does not exist` };
      }
      const nextStore = structuredClone(loaded.store);
      delete nextStore.routingChains[endpointId];
      if (Object.keys(nextStore.routingChains).length === 0) delete nextStore.routingChains;
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, endpointId };
    },

    /**
     * Rename a provider: update displayName only. The provider id is the wire
     * identity (relay routing, endpoint configs) and never changes here, so
     * this is pure metadata bookkeeping with the standard CAS write.
     */
    async renameProvider(id, displayName) {
      if (typeof displayName !== "string" || displayName.trim().length === 0) {
        return { ok: false, error: "displayName must be a non-empty string" };
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const entry = loaded.store.providers?.[id];
      if (!entry) return { ok: false, error: `Provider ${id} is not managed by Anyswitch` };
      const nextStore = structuredClone(loaded.store);
      nextStore.providers[id] = { ...entry, displayName: displayName.trim() };
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, id, displayName: displayName.trim() };
    },

    /**
     * Rename a pool: update displayName only (members untouched; the pool id
     * is reserved as a wire id and never changes here).
     */
    async renamePool(poolId, displayName) {
      if (typeof displayName !== "string" || displayName.trim().length === 0) {
        return { ok: false, error: "displayName must be a non-empty string" };
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const pool = loaded.store.pools?.[poolId];
      if (!pool) return { ok: false, error: `pool "${poolId}" does not exist` };
      const nextStore = structuredClone(loaded.store);
      nextStore.pools = { ...nextStore.pools, [poolId]: { ...pool, displayName: displayName.trim() } };
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, poolId, displayName: displayName.trim() };
    },

    /**
     * Reorder providers: 渠道顺序就是 providers map 的 JSON 插入序，排序通过
     * 同 key 同值重建对象实现，不引入 order 字段。order 必须是现有 provider
     * id 的排列（同集合、无重复、无缺失）；每个号池的 members 在 order 中
     * 必须连续成块——前端把池作为一个合并行拖拽已保证，这里是后端兜底。
     */
    async reorderProviders(order) {
      if (!Array.isArray(order) || order.some((id) => typeof id !== "string" || id.length === 0)) {
        return { ok: false, error: "order must be an array of provider ids" };
      }
      const loaded = load();
      if (!loaded.ok) return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
      const providers = loaded.store.providers ?? {};
      if (order.length !== Object.keys(providers).length || new Set(order).size !== order.length) {
        return { ok: false, error: "order must be a permutation of the existing provider ids" };
      }
      for (const id of order) {
        if (!Object.hasOwn(providers, id)) {
          return { ok: false, error: `Provider ${id} is not managed by Anyswitch` };
        }
      }
      const position = new Map(order.map((id, index) => [id, index]));
      for (const [poolId, pool] of Object.entries(loaded.store.pools ?? {})) {
        const members = Array.isArray(pool?.members) ? pool.members : [];
        if (members.length === 0) continue;
        const positions = members.map((id) => position.get(id)).sort((a, b) => a - b);
        if (positions[positions.length - 1] - positions[0] !== members.length - 1) {
          return { ok: false, error: `pool "${poolId}" members must stay contiguous in the channel order` };
        }
      }
      const nextStore = structuredClone(loaded.store);
      const reordered = {};
      for (const id of order) reordered[id] = nextStore.providers[id];
      nextStore.providers = reordered;
      const written = write(nextStore, { expectedHash: loaded.hash });
      if (!written.ok) return { ok: false, error: storeWriteError(written, "store write failed") };
      return { ok: true, order: [...order] };
    },

    /**
     * Delete a provider with the journal-driven forward-only transaction.
     * Business failures (store unavailable, unmanaged provider, unsafe
     * credential path) come back as { ok:false, error }; the credential is
     * retained in every failure path.
     */
    async deleteProvider(id) {
      try {
        const result = await deleteProviderOnce(id);
        return { ok: true, ...result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The journal-driven transaction surfaces the same recognizable conflict
        // string as every other CAS write; the credential was retained either way.
        return { ok: false, error: isCasReason(message) ? CAS_CONFLICT : message };
      }
    },

    /** Exposed for getState/tests: resume pending journal deletions. */
    resumeDeletions,
  };
}
