// Loaded only by the service worker. Never return provider errors or credentials.
class GeminiError extends Error {}

async function generateGeminiText(prompt, {maxOutputTokens = 4096, connectionTest = false} = {}) {
  const {provider, model, apiKey} = await chrome.storage.local.get({
    ...SETTINGS_DEFAULTS, apiKey: "",
  });
  if (provider !== "google") throw new GeminiError("Save your Gemini settings first.");
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new GeminiError("Add a Gemini API key in Settings and save it first.");
  }
  if (!isValidGeminiModel(model)) {
    throw new GeminiError("Enter a valid Gemini model ID in Settings and save it.");
  }
  const controller = new AbortController();
  // Stay below Chrome's 30-second fetch response limit for extension workers.
  const timeout = setTimeout(() => controller.abort(), 25000);
  let receivedHeaders = false;
  const generationConfig = {maxOutputTokens};
  // A connectivity check doesn't need the reviewer's normal reasoning effort.
  // thinkingLevel isn't supported by Gemini 2.x; don't send it to those models.
  if (connectionTest && /^gemini-[34][.-]/.test(model)) {
    generationConfig.thinkingConfig = {
      thinkingLevel: model === "gemini-3.5-flash-lite" ? "MINIMAL" : "LOW",
    };
  }
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {"Content-Type": "application/json", "x-goog-api-key": apiKey.trim()},
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{role: "user", parts: [{text: prompt}]}],
          generationConfig,
        }),
      }
    );
    receivedHeaders = true;
    if (!response.ok) {
      const messages = {
        400: "Google rejected the request. Check your Gemini key and model ID.",
        401: "Google rejected this API key. Replace it in Settings.",
        403: "This key cannot access Gemini. Check its permissions and API access in Google AI Studio.",
        404: "This Gemini model is unavailable. Check the model ID in Settings.",
        429: "Gemini's rate limit or quota was reached. Check your quota in Google AI Studio or try later.",
      };
      throw new GeminiError(messages[response.status] || (response.status >= 500
        ? "Gemini is temporarily unavailable. Try again later."
        : "Google could not complete the request. Check your Gemini settings."));
    }
    let data;
    try { data = await response.json(); }
    catch (error) {
      // Body reads also reject on abort; preserve the timeout diagnosis.
      if (controller.signal.aborted) throw error;
      throw new GeminiError("Gemini returned an unreadable response. Try again.");
    }
    if (data?.promptFeedback?.blockReason) {
      throw new GeminiError("Gemini blocked this request. No result was returned.");
    }
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") {
      throw new GeminiError("Gemini reached the response limit before finishing. Try again or choose another model.");
    }
    if (candidate?.finishReason !== "STOP") {
      throw new GeminiError("Gemini did not return a complete response. Try again.");
    }
    const parts = candidate?.content?.parts;
    const text = Array.isArray(parts) ? parts
      .filter(part => part && !part.thought && typeof part.text === "string")
      .map(part => part.text).join("").trim() : "";
    if (!text) throw new GeminiError("Gemini returned no text. Try again.");
    return text;
  } catch (error) {
    if (error instanceof GeminiError) throw error;
    throw new GeminiError(controller.signal.aborted
      ? (receivedHeaders
        ? "Google responded, but the response did not finish within 25 seconds. Try again."
        : "No response from Google within 25 seconds. Try again; if this persists, check whether your network or VPN can reach generativelanguage.googleapis.com.")
      : "Could not reach Gemini. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }
}
