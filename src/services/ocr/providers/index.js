// Provider registry. Add new adapters here (must satisfy providers/baseProvider.js).
const google = require("./googleDocumentAi");
const registry = { [google.key]: google };
module.exports = {
  get: (key) => registry[key] || null,
  list: () => Object.values(registry).map((p) => ({ key: p.key, displayName: p.displayName })),
  keys: () => Object.keys(registry),
};
