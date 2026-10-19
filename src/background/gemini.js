// Trusted extension pages and worker only. Never return provider errors or credentials.
class GeminiError extends Error {}

async function generateGeminiText(prompt, {maxOutputTokens = 4096, connectionTest = false, schema, signal, headerTimeout = 25000} = {}) {
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
  if (signal?.aborted) throw new GeminiError("Review cancelled.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, {once:true});
  // Worker connection tests stay below 30 seconds. The trusted panel can wait longer.
  let timeout = setTimeout(() => controller.abort(), headerTimeout);
  let receivedHeaders = false;
  const generationConfig = {maxOutputTokens};
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = schema;
  }
  // Keep the default Flash-Lite reviewer responsive; other review models keep their defaults.
  // thinkingLevel isn't supported by Gemini 2.x; don't send it to those models.
  if ((connectionTest || (schema && model === "gemini-3.5-flash-lite")) && /^gemini-[34][.-]/.test(model)) {
    generationConfig.thinkingConfig = {
      thinkingLevel: model === "gemini-3.5-flash-lite" ? "MINIMAL" : "LOW",
    };
  }
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${schema ? "streamGenerateContent?alt=sse" : "generateContent"}`,
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
    if (schema) {
      clearTimeout(timeout);
      // Streaming starts the response early; allow the review to finish after headers arrive.
      timeout = setTimeout(() => controller.abort(), 90000);
    }
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
    if (schema) return await readGeminiStream(response, controller.signal);
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
    if (signal?.aborted) throw new GeminiError("Review cancelled.");
    if (error instanceof GeminiError) throw error;
    throw new GeminiError(controller.signal.aborted
      ? (receivedHeaders
        ? (schema ? "Gemini did not finish the streamed review within 90 seconds. Cross-check again to retry." : "Google responded, but the response did not finish within 25 seconds. Try again.")
        : `No response from Google within ${headerTimeout / 1000} seconds. Try again; if this persists, check whether your network or VPN can reach generativelanguage.googleapis.com.`)
      : "Could not reach Gemini. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

async function readGeminiStream(response, signal) {
  if (!response.body) throw new GeminiError('Gemini returned an unreadable response. Try again.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', finished = false;
  function event(block) {
    const payload = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!payload || payload === '[DONE]') return;
    let data;
    try { data = JSON.parse(payload); }
    catch { throw new GeminiError('Gemini returned an unreadable response. Try again.'); }
    if (data.error) throw new GeminiError('Gemini could not finish the streamed review. Try again later.');
    if (data.promptFeedback?.blockReason) throw new GeminiError('Gemini blocked this request. No result was returned.');
    const candidate = data.candidates?.[0];
    if (!candidate) return;
    for (const part of candidate.content?.parts || []) {
      if (!part.thought && typeof part.text === 'string') text += part.text;
    }
    if (text.length > 80000) throw new GeminiError('Gemini’s response was too large. Try a smaller review.');
    if (candidate.finishReason === 'MAX_TOKENS') throw new GeminiError('Gemini reached the response limit before finishing. Try a smaller review.');
    if (candidate.finishReason && candidate.finishReason !== 'STOP') throw new GeminiError('Gemini did not return a complete response. Try again.');
    if (candidate.finishReason === 'STOP') finished = true;
  }
  try {
    while (!finished) {
      if (signal.aborted) throw new Error('Aborted');
      const {done,value} = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value,{stream:true});
      // Normalize complete CRLF pairs only; a chunk can end halfway through one.
      buffer = buffer.replace(/\r\n/g,'\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2); event(block);
      }
      if (buffer.length > 200000) throw new GeminiError('Gemini returned an unreadable response. Try again.');
      if (done) { if (buffer.trim()) event(buffer); break; }
    }
    if (!finished || !text.trim()) throw new GeminiError('Gemini did not return a complete response. Try again.');
    return text.trim();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
