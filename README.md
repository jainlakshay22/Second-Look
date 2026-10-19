# Second Look

A Manifest V3 Chrome extension that adds **Cross-check** to ChatGPT answers and reviews them through the **Gemini API**. No Gemini website login or extra Gemini tabs are needed.

## Load and connect

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder. For an existing installation, click **Reload**.
2. Open Second Look's **API key / Settings** from the extension popup.
3. Paste your Gemini API key, then **Save settings**. An existing saved Gemini key is preserved; leave the field blank to keep it.
4. Click **Test connection**. This sends only a small test prompt; API usage may be billed.
5. Refresh any ChatGPT tab opened before loading or reloading the extension.

Default model: `gemini-3.5-flash-lite`, with minimal thinking for faster reviews. You can change the model in Settings. See Google's [model information](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) and [structured-output documentation](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).

## Review an answer

Click **Cross-check** under an answer. The side panel shows the question, selected answer, suggested earlier messages, and exact review prompt. Adjust the context and click **Send to Gemini**, or **Cancel**. The structured result appears in the same panel. Keep the panel open while a review runs; closing it cancels the local request. No browser login is involved.

## Privacy and limits

- Conversation text is sent only after **Send to Gemini**. Saving settings and previewing send nothing.
- Your API key stays in local Chrome storage, restricted to trusted extension pages. It is not synced, bundled in the extension, included in URLs, or sent to ChatGPT. It is not encrypted by the extension. Only trusted extension code sends it to Google's API in the authentication header.
- One installed Chrome profile uses its saved key for all reviews. To distribute the extension using one centrally owned key, add a server-side proxy first; do not bundle the key in extension files.
- Review context and results use trusted-only `chrome.storage.session` and clear on browser restart or extension reload. Cancel clears captured context. Google receives submitted prompts under its API data policies; cancellation cannot undo a request already received by Google.
- Only currently loaded ChatGPT text is available. Files, hidden prompts, and memories are not captured. Each message is capped at 8,000 characters, marked `[Truncated]`; the complete prompt is capped at 32,000 characters.
- Context suggestions use local word overlap and follow-up hints. Check the selection before sending.
- Connection tests wait up to 25 seconds. Full reviews run in the trusted side panel and wait up to 90 seconds for initial response headers. Reviews stream over the API and can continue for up to 90 seconds after headers arrive. Quota, invalid-key, model, network, and incomplete-response errors are shown without raw provider details. There are no automatic retries. After an error, Cross-check again to retry.
- A second model's review is not independent fact verification. Unexpected output is shown safely as text.

## Files

- `manifest.json`: extension permissions, ChatGPT script, worker, popup, and side panel.
- `selectors.js`: all DOM query selectors for ChatGPT and extension pages.
- `content.js`, `context.js`, `content.css`: ChatGPT buttons and local context extraction.
- `src/background/gemini.js`: API requests, structured output, cancellation, timeouts, and sanitized errors.
- `src/background/service-worker.js`: trusted message routing, duplicate-request protection, and session storage.
- `src/shared/review.js`: reviewer prompt, context suggestions, schema, and output validation.
- `src/shared/settings.js`, `src/options/`: local key/model settings and connection test.
- `src/sidepanel/`: preview, Send/Cancel, progress, and structured results.

## Checks

Run `node --test tests/*.test.cjs` (Node 20+). Tests use synthetic text, fake credentials, and mocked Chrome/API responses. Manually verify Settings → Test connection, preview cancellation, and a completed review after changes to API integration.
