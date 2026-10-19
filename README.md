# Second Look

A Manifest V3 Chrome extension that adds **Cross-check** to ChatGPT answers and reviews them through the user's signed-in Gemini website account. This is an experimental browser integration, not an official Gemini integration.

## Load and connect

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
2. Open Second Look's **Settings** from the extension popup.
3. Select **Open Gemini / sign in**. Sign in on Google's own page and select your preferred account.
4. Return to Settings and select **Check connection**. No API key is required.
5. Refresh any ChatGPT tab that was open before loading or reloading the extension.

## Review an answer

Click **Cross-check** under an answer. The side panel shows the question, selected answer, suggested earlier messages, and exact review prompt. Adjust the context and click **Send to Gemini**, or **Cancel**. A fresh Gemini tab opens automatically; keep it open until the response arrives in the side panel. If Gemini needs sign-in or setup, finish it there and press **Continue review** in the panel. Avoid typing in the dedicated review tab while it is running.

The Gemini website controls the model and account limits. To switch accounts, repeat the setup steps. A multi-account Gemini URL is remembered when the website exposes one; otherwise Gemini's default signed-in account applies. The extension does not independently authenticate an account or read passwords, tokens, or cookies.

## Privacy and limitations

- Nothing is submitted until **Send to Gemini**. Opening Settings or checking connection submits no prompt.
- Questions, answers, and results stay in `chrome.storage.session`, restricted to trusted extension pages. They are not saved to disk by extension code; session storage clears when Chrome restarts or the extension reloads. Cancel clears the local captured context.
- Sent prompts and responses may remain in the user's Gemini history and are subject to Google's account settings. Stop waiting cannot undo a submission.
- Existing API keys from the earlier prototype are unused. Settings offers **Remove old API key** to delete one. There is no API endpoint permission or API request code in this version.
- Only currently loaded ChatGPT text is available. Files, tool results, hidden prompts, and memories are not captured. Each message is limited to 8,000 characters with a `[Truncated]` marker. The preview limits the total prompt to 32,000 characters.
- Context suggestions use local word overlap and follow-up hints, not semantic certainty. Check the selection before sending.
- Gemini's website markup, English accessibility labels, sign-in flows, usage limits, or unexpected dialogs can interrupt automation. Non-English Gemini interfaces may require selector updates. It will not automatically resubmit uncertain requests.
- A second model's review is not independent fact verification. Unexpected output is shown safely as plain text.

## Files

- `selectors.js`: every DOM query selector for ChatGPT, Gemini, and extension pages.
- `content.js`, `context.js`, `content.css`: ChatGPT buttons and local context extraction.
- `src/gemini/content.js`: fills an empty Gemini chat once, watches completion, returns only the new review.
- `src/background/service-worker.js`: trusted message routing, consent state, dedicated tabs, session storage.
- `src/shared/review.js`: prompt, local context suggestions, output validation.
- `src/options/`: browser-account setup and capture settings.
- `src/sidepanel/`: preview, Send/Cancel, progress, and structured results.

## Checks

Run `node --test tests/*.test.cjs` (Node 20+). These tests use synthetic text and mocked Chrome APIs. Manually verify account setup, preview cancellation, a completed review, and the closed-tab error after changes to browser integration. The initial reviewer instructions were tried in Gemini with correct multiplication, an incorrect capital city, and an unsafe JavaScript function.
