// Global ApiCred model catalog resolver.
// Pure functions only. No IO, no DPAPI, no network. Synthetic input only.
//
// Contract:
//   modelId         = model.id   ?? config key
//   displayName     = model.name ?? config key  (not the resolved modelId)
//   contextWindow   = model.limit.context  (write only when the property is present)
//   maxOutputTokens = model.limit.output   (write only when the property is present)
// The built-in `opencode` provider contributes whitelist ∪ models. All other
// providers ignore any whitelist and use only their explicit models map.
//
// Limit values are passed through as-is when present; their legality (e.g. must
// be a positive integer) is enforced by store-schema validation, not silently
// dropped here, so an invalid catalog surfaces as a schema error instead of
// vanishing from the output.

// Resolve a single OpenCode-style model entry into a Store model object.
function resolveModel(configKey, entry) {
  const model = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const modelId = typeof model.id === "string" && model.id.length > 0 ? model.id : configKey;
  const displayName = typeof model.name === "string" && model.name.length > 0 ? model.name : configKey;

  const resolved = { displayName };
  const limit = model.limit && typeof model.limit === "object" ? model.limit : {};
  if ("context" in limit) resolved.contextWindow = limit.context;
  if ("output" in limit) resolved.maxOutputTokens = limit.output;

  if ("supportsReasoning" in model) resolved.supportsReasoning = model.supportsReasoning;
  if ("reasoningEffortLevels" in model) resolved.reasoningEffortLevels = model.reasoningEffortLevels;
  if ("defaultEffort" in model) resolved.defaultEffort = model.defaultEffort;

  return { modelId, resolved };
}

// Resolve all models for one provider. `providerId` selects opencode whitelist
// behaviour. `config` is the OpenCode-style provider config: { models?, whitelist? }.
export function resolveProviderModels(providerId, config) {
  const source = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const models = source.models && typeof source.models === "object" && !Array.isArray(source.models)
    ? source.models
    : {};

  // Keys to resolve: explicit model keys, plus whitelist keys for opencode only.
  const keys = new Set(Object.keys(models));
  if (providerId === "opencode" && Array.isArray(source.whitelist)) {
    for (const key of source.whitelist) {
      if (typeof key === "string" && key.length > 0) keys.add(key);
    }
  }

  const out = {};
  for (const configKey of keys) {
    const { modelId, resolved } = resolveModel(configKey, models[configKey]);
    out[modelId] = resolved;
  }
  return out;
}
