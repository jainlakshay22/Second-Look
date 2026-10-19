// Trusted extension pages and worker only. Never return provider errors or credentials.
class GeminiError extends Error {}

// Existing v1 callers keep their string return value. Verification callers use
// generateGeminiReview for validated claims plus provider evidence in an envelope.
async function generateGeminiText(prompt, options = {}) {
  return (await generateGeminiResponse(prompt, options)).text;
}

async function generateGeminiResponse(prompt, {maxOutputTokens = 4096, connectionTest = false, schema, signal, headerTimeout = 25000, mode = 'review', groundingEnabled: authorizedGrounding} = {}) {
  if (!['review', 'verify_claims'].includes(mode)) throw new GeminiError('Unknown review mode.');
  const {provider, model, apiKey, groundingEnabled} = await chrome.storage.local.get({
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
  const grounded = mode === 'verify_claims' && !connectionTest && (typeof authorizedGrounding === 'boolean' ? authorizedGrounding : groundingEnabled) === true;
  if (mode === 'verify_claims' && !connectionTest) schema = getReviewResponseSchema(mode);
  // Structured output with built-in tools is documented for Gemini 3/4 only.
  // Reject locally rather than silently falling back to an ungrounded verdict.
  if (grounded && !/^gemini-[34][.-]/.test(model)) {
    throw new GeminiError('Search grounding with claim verification requires a Gemini 3 or 4 model. Change the model or turn off Search grounding in Settings.');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, {once:true});
  // Worker connection tests stay below 30 seconds. The trusted panel can wait longer.
  let timeout = setTimeout(() => controller.abort(), headerTimeout);
  let receivedHeaders = false;
  const generationConfig = {maxOutputTokens};
  if (schema) {
    if (mode === 'verify_claims' && !connectionTest) {
      // Current REST output format. Local validation keeps length/URL/uniqueness
      // constraints locally instead of adding complexity to the provider grammar.
      generationConfig.responseFormat = {text: {
        mimeType: 'APPLICATION_JSON', schema: geminiClaimSchema(schema),
      }};
    } else {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseJsonSchema = schema;
    }
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
          // REST: https://ai.google.dev/gemini-api/docs/generate-content/google-search
          ...(grounded ? {tools: [{google_search: {}}]} : {}),
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
      if (response.status === 400) {
        let data;
        try { data = await response.json(); } catch { /* Never expose a raw error body. */ }
        throw new GeminiError(geminiBadRequestMessage(data, mode));
      }
      const messages = {
        401: "Google rejected this API key. Replace it in Settings.",
        403: "This key cannot access Gemini. Check its permissions and API access in Google AI Studio.",
        404: "This Gemini model is unavailable. Check the model ID in Settings.",
        429: "Gemini's rate limit or quota was reached. Check your quota in Google AI Studio or try later.",
      };
      throw new GeminiError(messages[response.status] || (response.status >= 500
        ? "Gemini is temporarily unavailable. Try again later."
        : "Google could not complete the request. Check your Gemini settings."));
    }
    if (schema) {
      const result = await readGeminiStream(response, controller.signal, grounded);
      return geminiResponseResult(result.text, result.metadata, grounded);
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
    return geminiResponseResult(text, [], false);
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

async function readGeminiStream(response, signal, collectGrounding = false) {
  if (!response.body) throw new GeminiError('Gemini returned an unreadable response. Try again.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', finished = false, metadataSize = 0;
  const metadata = [];
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
    if (collectGrounding && candidate.groundingMetadata) {
      metadataSize += JSON.stringify(candidate.groundingMetadata).length;
      if (metadataSize > 200000) throw new GeminiError('Gemini returned too much source metadata. Try a smaller review.');
      metadata.push(candidate.groundingMetadata);
    }
    for (const part of candidate.content?.parts || []) {
      if (!part.thought && typeof part.text === 'string') text += part.text;
    }
    if (text.length > 80000) throw new GeminiError('Gemini’s response was too large. Try a smaller review.');
    if (candidate.finishReason === 'MAX_TOKENS') throw new GeminiError('Gemini reached the response limit before finishing. Try a smaller review.');
    if (candidate.finishReason && candidate.finishReason !== 'STOP') throw new GeminiError('Gemini did not return a complete response. Try again.');
    if (candidate.finishReason === 'STOP') finished = true;
  }
  try {
    // Grounding can arrive in a metadata-only event after the STOP event.
    // Keep reading to EOF for grounded requests, under the existing stream deadline.
    while (collectGrounding || !finished) {
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
    return {text: text.trim(), metadata};
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}


function geminiResponseResult(text, metadata, enabled) {
  const sources = new Set();
  for (const entry of metadata) {
    for (const chunk of Array.isArray(entry.groundingChunks) ? entry.groundingChunks : []) {
      const uri = chunk?.web?.uri;
      if (typeof uri !== 'string' || uri.length > 4096 || !/^https?:\/\//.test(uri)
          || /[\s\u0000-\u001f\u007f\\]/.test(uri)) continue;
      try {
        const url = new URL(uri);
        if (url.hostname && !url.username && !url.password) sources.add(uri);
      } catch { /* Ignore malformed provider URLs; never invent replacements. */ }
    }
  }
  return {text, grounding: {
    enabled,
    status: !enabled ? 'disabled' : sources.size ? 'grounded' : 'no_sources',
    sources: [...sources],
    // Preserve support mappings and Search Suggestions for the later source UI.
    // Provider HTML is inert data here; never inject it into the page.
    metadata,
  }};
}

// Claim verification returns its validated review and provider evidence together.
// The review keeps its strict JSON contract; evidence lives beside it, not inside it.
async function generateGeminiReview(context, selected, {mode = 'review', groundingEnabled, approvedPrompt, ...options} = {}) {
  if (typeof groundingEnabled !== 'boolean') {
    const stored = await chrome.storage.local.get({groundingEnabled: SETTINGS_DEFAULTS.groundingEnabled});
    groundingEnabled = stored.groundingEnabled === true;
  }
  const prompt = buildReviewPrompt(context, selected, {mode, groundingEnabled});
  if (approvedPrompt !== undefined && approvedPrompt !== prompt) {
    throw new GeminiError('The review input changed. Reopen the preview before sending again.');
  }
  if (prompt.length > REVIEW_LIMIT) throw new GeminiError('The review is too large. Select less context.');
  const result = await generateGeminiResponse(prompt, {
    ...options, mode, groundingEnabled, connectionTest: false, schema: getReviewResponseSchema(mode),
  });
  const review = parseReview(result.text, {mode, answer: context.reply});
  if (!review) throw new GeminiError('Gemini returned an invalid review. Try again.');
  if (mode === 'verify_claims') {
    const allowed = new Set(result.grounding.sources);
    let downgraded = false;
    for (const claim of review.claims) {
      // Only retain the model's claim-specific citations if the provider actually
      // returned them. Do not attach every search result to every claim, or guess
      // that a direct URL and a Google redirect URL identify the same evidence.
      const hadSources = claim.sources.length > 0;
      claim.sources = claim.sources.filter(url => allowed.has(url));
      if (!claim.sources.length && (hadSources || claim.verdict !== 'unverified')) {
        claim.verdict = 'unverified';
        claim.explanation = 'No matching Google Search source was returned for this claim, so it could not be verified.';
        downgraded = true;
      }
    }
    if (!review.claims.length) {
      review.summary = 'No checkable factual claims were extracted from this answer.';
    } else if (result.grounding.status === 'no_sources') {
      review.summary = 'Google Search returned no usable sources. These claims remain unverified.';
    } else if (result.grounding.status === 'disabled') {
      review.summary = 'Search grounding is off. These claims have not been independently verified.';
    } else if (downgraded) {
      review.summary = 'Some claims lack matching Google Search sources and remain unverified. See each claim for the verification result.';
    }
  }
  return {review, grounding: result.grounding};
}


// Only Gemini's documented JSON Schema subset goes over the wire. In particular,
// don't send minLength/maxLength, pattern, or uniqueItems. parseReview remains the
// authority for exact quotes, limits, safe URLs and distinct IDs; grounding checks
// still enforce source provenance after parsing.
// https://ai.google.dev/gemini-api/docs/generate-content/structured-output
function geminiClaimSchema(schema) {
  const result = {};
  for (const key of ['type','enum','required','additionalProperties']) {
    if (Object.hasOwn(schema,key)) result[key] = schema[key];
  }
  if (schema.properties) result.properties = Object.fromEntries(
    Object.entries(schema.properties).map(([key,value]) => [key,geminiClaimSchema(value)])
  );
  if (schema.items) result.items = geminiClaimSchema(schema.items);
  return result;
}

function geminiBadRequestMessage(data, mode) {
  // Classify privately into fixed messages: Google can echo inputs or credentials
  // in its error message/details. Never return or log those values.
  const error = data?.error;
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const reasons = Array.isArray(error?.details) ? error.details.map(item => item?.reason) : [];
  if (reasons.includes('API_KEY_INVALID') || /api.?key.*(invalid|expired)|api key not valid/.test(message)) {
    return 'Google rejected this API key. Replace it in Settings.';
  }
  if (reasons.includes('BILLING_DISABLED') || /billing.*(enable|required)|free tier.*(unavailable|not available)/.test(message)) {
    return 'Google requires billing for this request. Check the API project in Google AI Studio.';
  }
  if (/schema|response.?format|response.?mime.?type|constraint/.test(message)) {
    return 'Google rejected the structured response format for this model. Reload the extension to use the updated format. If it persists, choose a model that supports structured output with Google Search, or turn off Search grounding in Settings.';
  }
  if (/google.?search|grounding|tools?/.test(message)) {
    return 'This Gemini model rejected Google Search grounding. Choose a model that supports Search grounding, or turn it off in Settings.';
  }
  if (/thinking/.test(message)) {
    return 'Google rejected this model’s thinking configuration. Choose another Gemini model in Settings.';
  }
  return mode === 'verify_claims'
    ? 'Google rejected the claim-verification request (HTTP 400). Reload the extension to use the updated request format; if it persists, check the model and Search grounding setting.'
    : 'Google rejected the request (HTTP 400). Check your Gemini model and API settings.';
}
