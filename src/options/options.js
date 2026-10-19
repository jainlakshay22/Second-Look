const fields = Object.fromEntries(
  Object.entries(SETTINGS_SELECTORS).map(([name, selector]) => [name, document.querySelector(selector)])
);
let hasSavedKey = false;
let savedModel = "";

function setStatus(message, state = "success") {
  fields.status.textContent = message;
  fields.status.dataset.state = state;
}

function updateKeyStatus() {
  fields.apiKey.value = "";
  fields.apiKey.placeholder = hasSavedKey ? "Saved key · enter a replacement" : "Enter your API key";
  fields.keyStatus.textContent = hasSavedKey ? "A key is saved locally." : "No key saved.";
  fields.removeKey.disabled = !hasSavedKey;
}

async function loadSettings() {
  try {
    await restrictSettingsStorage();
    const stored = await chrome.storage.local.get({...SETTINGS_DEFAULTS, apiKey: ""});
    const isGemini = stored.provider === "google";
    fields.provider.value = "google";
    fields.model.value = isGemini && isValidGeminiModel(stored.model) ? stored.model : SETTINGS_DEFAULTS.model;
    savedModel = fields.model.value;
    fields.historyCount.value = isValidHistoryCount(stored.historyCount) ? stored.historyCount : SETTINGS_DEFAULTS.historyCount;
    fields.groundingEnabled.checked = stored.groundingEnabled === true;
    hasSavedKey = isGemini && typeof stored.apiKey === "string" && stored.apiKey.trim().length > 0;
    updateKeyStatus();
    fields.fieldset.disabled = false;
    setStatus("Ready. Changes are saved only when you click Save settings.");
  } catch {
    setStatus("Could not load settings. Reload this page to try again.", "error");
  }
}

fields.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!fields.form.reportValidity()) return;
  const provider = fields.provider.value;
  const model = fields.model.value.trim();
  const historyCount = Number(fields.historyCount.value);
  const apiKey = fields.apiKey.value.trim();
  if (!SETTINGS_PROVIDERS.includes(provider) || !isValidGeminiModel(model)
      || !isValidHistoryCount(historyCount) || apiKey.length > 4096) {
    setStatus("Enter a Gemini model ID (starting with gemini-) and use a history count from 0 to 20.", "error");
    return;
  }
  fields.fieldset.disabled = true;
  try {
    await restrictSettingsStorage();
    const previous = await chrome.storage.local.get({provider: SETTINGS_DEFAULTS.provider});
    const changes = {provider, model, historyCount, groundingEnabled: fields.groundingEnabled.checked};
    if (apiKey) changes.apiKey = apiKey;
    // Never reuse a saved credential with a different provider.
    else if (previous.provider !== provider) changes.apiKey = "";
    await chrome.storage.local.set(changes);
    savedModel = model;
    if (Object.hasOwn(changes, "apiKey")) hasSavedKey = Boolean(changes.apiKey);
    updateKeyStatus();
    setStatus(hasSavedKey ? "Settings saved locally. No connection has been tested." : "Settings saved locally. Add an API key before requesting a review.");
  } catch {
    setStatus("Could not save settings. Your changes have not been confirmed; try again.", "error");
  } finally {
    fields.fieldset.disabled = false;
  }
});

fields.removeKey.addEventListener("click", async () => {
  fields.fieldset.disabled = true;
  try {
    await restrictSettingsStorage();
    await chrome.storage.local.remove("apiKey");
    hasSavedKey = false;
    updateKeyStatus();
    setStatus("Saved API key removed. Your other saved settings are unchanged.");
  } catch {
    setStatus("Could not remove the saved key. Try again.", "error");
  } finally {
    fields.fieldset.disabled = false;
  }
});

fields.testConnection.addEventListener("click", async () => {
  if (fields.apiKey.value.trim() || fields.model.value.trim() !== savedModel) {
    setStatus("Save your settings before testing the connection.", "error");
    return;
  }
  if (!hasSavedKey) {
    setStatus("Add a Gemini API key and save your settings first.", "error");
    return;
  }
  fields.fieldset.disabled = true;
  setStatus("Testing Gemini with a small test prompt…", "pending");
  let timeout;
  try {
    // A stopped worker may never answer. Always let the user recover the form.
    const response = await Promise.race([
      chrome.runtime.sendMessage({type: "TEST_GEMINI_CONNECTION"}),
      new Promise(resolve => {
        timeout = setTimeout(() => resolve({error:
          "The extension did not finish the test. Reload it at chrome://extensions, reopen Settings, and try again."
        }), 35000);
      }),
    ]);
    if (response?.ok === true) setStatus("Connected to Gemini. No conversation content was sent.");
    else setStatus(typeof response?.error === "string" ? response.error : "Connection test failed. Try again.", "error");
  } catch {
    setStatus("Could not contact the extension. Reload it and try again.", "error");
  } finally {
    clearTimeout(timeout);
    fields.fieldset.disabled = false;
  }
});

loadSettings();
