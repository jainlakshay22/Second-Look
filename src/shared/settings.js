// Trusted extension pages and the worker share validation; no secrets live here.
const SETTINGS_DEFAULTS = Object.freeze({provider: "google", model: "gemini-3.5-flash-lite", historyCount: 4});
const SETTINGS_PROVIDERS = Object.freeze(["google"]);

function isValidGeminiModel(value) {
  return typeof value === "string" && value.length <= 128 && /^gemini-[a-zA-Z0-9._-]+$/.test(value);
}

function isValidHistoryCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 20;
}

function restrictSettingsStorage() {
  // Local storage is otherwise exposed to content scripts by default.
  return chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
}
