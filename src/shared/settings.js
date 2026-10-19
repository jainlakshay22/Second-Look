const SETTINGS_DEFAULTS = Object.freeze({historyCount: 4, geminiHome: 'https://gemini.google.com/app'});
function isValidHistoryCount(value) { return Number.isInteger(value) && value >= 0 && value <= 20; }
function restrictSettingsStorage() {
  return chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
}
function geminiHomeFor(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://gemini.google.com') return null;
    const match = parsed.pathname.match(/^\/(?:u\/(\d+)\/)?app(?:\/|$)/);
    return match ? `https://gemini.google.com/${match[1] ? `u/${match[1]}/` : ''}app` : null;
  } catch { return null; }
}
