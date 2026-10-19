importScripts("../shared/settings.js", "gemini.js");

// Reapply on every worker start, including after extension/browser restarts.
const storageReady = restrictSettingsStorage().then(() => true, () => false);
let connectionTestRunning = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "TEST_GEMINI_CONNECTION") {
    // Content scripts cannot trigger API calls. Only our Settings page can test.
    if (sender.url !== chrome.runtime.getURL("src/options/options.html")) return false;
    if (connectionTestRunning) {
      sendResponse({error: "A connection test is already running."});
      return false;
    }
    connectionTestRunning = true;
    (async () => {
      try {
        if (!await storageReady) throw new Error("Storage unavailable");
        // This fixed prompt contains no conversation data or message payload.
        await generateGeminiText("Reply with exactly OK.", 2048);
        sendResponse({ok: true});
      } catch (error) {
        sendResponse({error: error instanceof GeminiError ? error.message
          : "Could not read Gemini settings. Reload the extension and try again."});
      } finally {
        connectionTestRunning = false;
      }
    })();
    return true;
  }
  if (message?.type !== "GET_CAPTURE_SETTINGS") {
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
