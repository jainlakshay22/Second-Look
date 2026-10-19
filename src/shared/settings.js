// Trusted extension pages and the worker share validation; no secrets live here.
const SETTINGS_DEFAULTS = Object.freeze({provider: "", model: "", historyCount: 4});
const SETTINGS_PROVIDERS = Object.freeze(["openai", "anthropic", "google", "openrouter"]);

function isValidHistoryCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 20;
}

function restrictSettingsStorage() {
  // Local storage is otherwise exposed to content scripts by default.
  return chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
}
