# Privacy and technical details

[Back to Second Look](../README.md)

## What leaves the browser

Saving settings, capturing an answer, selecting context, and previewing a review send no conversation text to Google. **Send to Gemini** authorizes the request. The preview shows the exact prompt, including the selected answer, question, and chosen earlier messages.

**Test connection** sends a small synthetic prompt using the saved API settings. It includes no captured conversation content, but API usage may be billed.

In **Verify claims** mode, enabling Search grounding allows Google to generate search queries from the submitted text. The preview discloses this before Send. The grounding setting is fixed for the authorized request; if it changes before authorization, the user must review the updated preview and send again. Search usage may incur additional charges.

Submitted prompts are processed under Google's API data policies. Cancelling locally cannot undo a request Google has already received or eliminate usage already incurred.

## API keys and storage

- The API key stays in local Chrome storage restricted to trusted extension pages. It is not synced, bundled in the extension, put in URLs, or sent to ChatGPT.
- The extension does not encrypt the key. Trusted extension code sends it to Google's API in the authentication header.
- Leaving the API key field blank when saving Settings preserves the existing Gemini key. **Remove saved key** deletes it.
- One installed Chrome profile uses its saved key for all reviews. A centrally funded public distribution would require a server-side proxy; do not bundle a shared key in extension files.
- Review context, selected mode, and results use trusted-only `chrome.storage.session`. They clear on browser restart or extension reload. Cancel clears the captured context from the active review.
- No Gemini website login, Gemini tab automation, or Second Look account is required.

## Permissions and request handling

This is a Manifest V3 extension. Its content script runs on `chatgpt.com`; API host access is limited to `generativelanguage.googleapis.com`. It uses Chrome storage and the side panel.

The service worker checks message origins, review IDs, and state. Only the trusted panel can authorize Send. The worker saves the waiting state before the panel submits the request, rejects duplicate sends and stale results, and does not automatically replay requests after a restart.

## Captured context and size limits

Only currently loaded ChatGPT text is available. Files, hidden prompts, and memories are not captured. Each message is capped at **8,000 characters**, with truncation marked `[Truncated]`; the complete prompt is capped at **32,000 characters**.

Earlier-message suggestions use local word overlap and follow-up hints. They are a convenience, not a guarantee that every relevant dependency was found. Check the selection before sending, and deselect earlier messages if the prompt exceeds the limit.

## Models and grounding

The default is `gemini-3.5-flash-lite`, using minimal thinking for responsive reviews. The model can be changed in Settings. The current client requires a Gemini 3 or 4 model when combining structured claim output with Google Search. Provider availability and project quota still apply.

Reference: Google's [model information](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) and [structured-output documentation](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).

Regular **Review** requests do not search. **Verify claims** uses Search only when the Settings toggle is enabled. The application retains provider grounding metadata and only keeps a claim's citation if that exact URL occurs in the returned source list. It does not assume that a direct publisher URL and a Google redirect URL refer to the same evidence. Missing or unmatched sources can therefore result in an **unverified** label even when a model supplies a plausible explanation.

Unverified means insufficient matching evidence, not false. A source match establishes provenance, not a guarantee that the source is accurate or that the model interpreted it correctly.

## Timeouts, cancellation, and retries

- Connection tests run in the worker with a **25-second** request deadline. The Settings page stops waiting for the extension after 35 seconds if it receives no response.
- Full reviews run in the trusted side panel. They allow up to **90 seconds** for response headers, then up to **90 seconds** for the streamed response to finish. The worker expires an abandoned waiting review after 190 seconds.
- Keep the panel open during a review. Closing it aborts the local request. **Stop waiting** also cancels locally; Google may already have processed the request.
- Quota, key, model, network, format, and incomplete-response errors are shown without exposing raw provider-error details. A quota error does not imply a bad API key or guarantee that another immediate attempt will succeed.
- There are **no automatic retries**. After an error, **Review context & retry** opens the same captured answer and context selection. Nothing is sent until another **Send to Gemini** confirmation.
- **Review again** also reopens a preview. To capture newer text, click **Cross-check** in ChatGPT again.

## Safe display and validation

The panel renders answer text, model explanations, and source titles with text nodes rather than injecting model HTML. Source links must be HTTP(S) URLs and open with `noopener noreferrer`.

Claim quotes must match the captured answer exactly. The panel handles overlapping and repeated matches and keeps unmatched claims visible below the answer. Structured verification output is validated locally, including claim IDs, verdicts, quote anchors, size limits, and source references. Invalid verification output produces an error; unexpected regular Review output has an inert plain-text fallback.

A model review is not a guarantee of factual accuracy. Check the evidence behind consequential claims yourself.

## Evaluation data

The evaluation runner uses an environment-variable API key and synthetic fixtures, independently of Chrome storage. Results remain local and are ignored by Git. The runner saves progress and stops on quota/authentication/configuration errors without retrying automatically. See the [evaluation guide](../eval/README.md) for exact behavior and scoring limitations.
