importScripts("../shared/settings.js");

// Reapply on every worker start, including after extension/browser restarts.
const storageReady = restrictSettingsStorage().then(() => true, () => false);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "GET_CAPTURE_SETTINGS") {
    return false;
  }
  (async () => {
    try {
      if (!await storageReady) throw new Error("Storage unavailable");
      const {historyCount} = await chrome.storage.local.get({historyCount: SETTINGS_DEFAULTS.historyCount});
      // Return only the setting needed by the content script, never the API key.
      sendResponse({historyCount: isValidHistoryCount(historyCount) ? historyCount : SETTINGS_DEFAULTS.historyCount});
    } catch {
      sendResponse({error: "Could not read settings. Reload the extension and refresh ChatGPT."});
    }
  })();
  return true;
});
