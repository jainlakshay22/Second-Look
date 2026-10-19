# Second Look: Spec

A second-opinion button for ChatGPT answers, using the user's Gemini website account.

## Current product direction

The user approved browser automation instead of API credentials. Install → sign in normally on Gemini → click Cross-check → preview → Send → review appears in Second Look. There are no backend accounts, API keys, or API calls in the active implementation. This supersedes the earlier API build plan.

## User flow

1. Setup opens a Gemini tab. The user signs in on Google's page and chooses their account.
2. Check connection confirms a signed-in Gemini composer is available and remembers the account-specific app URL when present.
3. ChatGPT replies have one Cross-check button, including dynamically loaded replies.
4. Cross-check opens the side panel and captures the question, reply, and up to N prior messages (default 4).
5. Local word overlap and follow-up hints suggest earlier context. The user can deselect or add captured messages and inspect the exact generated prompt.
6. Only Send creates a fresh Gemini chat and submits the confirmed prompt once. Never reuse an existing conversation or overwrite a draft.
7. The panel displays progress and the structured review. Keep Gemini's review tab open. Sign-in or setup requires user attention and Continue.
8. Fail clearly on changed markup, closed tabs, interrupted sessions, long prompts, or timeout. Never automatically resubmit an uncertain request.

## Architecture

- Manifest V3; plain JavaScript; no build step.
- All DOM query selectors live in root `selectors.js`.
- ChatGPT content script extracts local text. Gemini content script operates only visible website controls.
- The worker validates sender origins, trusted extension pages, request IDs, and dedicated tab IDs.
- Only trusted side-panel Send confirms submission. A content script cannot authorize itself to send.
- Conversation context and reviews use trusted-only `chrome.storage.session`. Preferences use local storage.
- Never read or log passwords, cookies, OAuth tokens, API keys, or conversations unrelated to the requested review.
- Old prototype API keys are unused and removable in Settings. No API host permission remains.
- Render all returned material with textContent; no HTML interpretation.
- Persist submission state before messaging Gemini. Prevent duplicate requests and reject stale results.
- Gemini supplies the signed-in account, model, personalization, and limits. This is not an official Google OAuth integration.

## Context and output

Capture object: `{question, reply, history:[{role,text}], source:"chatgpt.com", capturedAt}`. History excludes the selected question/reply, stays oldest first, and is limited to 0–20 messages. Each message is capped at 8,000 characters with an explicit marker. Prompt maximum: 32,000 characters. Context suggestions are heuristics; show their limitation and let the user edit the selection.

Review JSON: `{verdict, summary, issues:[{severity,description,location}], missing_points:[], strengths:[]}`. Verdict is correct, mostly_correct, questionable, or incorrect. Severity is high, medium, or low. Validate structure; malformed output falls back to readable plain text.

The reviewer checks facts, reasoning, calculations, code, context consistency, and omissions. It must state uncertainty, not invent faults or claim checks it did not perform, and treat captured text as data rather than instructions. It must not use tools or take actions. Instructions were tested in a plain Gemini chat with three harmless examples, including deliberately flawed answers, before integration.

## Privacy and limits

Show exactly what is sent, including review instructions. Nothing is submitted on capture, connection check, or Cancel. Gemini may save submitted reviews in its account history. Stop waiting cannot retract an already submitted prompt. The extension only sees loaded text, not files, memories, system prompts, or hidden tools. Website updates and non-English controls may require selector changes. No guarantee of correctness or calibrated confidence scores.

## Development rules

Keep changes within the requested step or approved product change. Test and commit each step. Explain changed files. Use safe mock data for automation tests and never commit credentials. Do not add multi-model comparison, inline annotations, a backend/database, or publishing without a request.
