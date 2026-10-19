# Second Look: Spec

> A second-opinion button for AI answers.

Paste this file at the start of every new AI coding chat, followed by the single task for that session.

---

## 1. What it is

Second Look is a Chrome extension (Manifest V3) that adds a **"Cross-check"** button under each AI reply on chatgpt.com. When clicked, it sends the question, the selected reply, and a limited amount of recent conversation to a *different* AI model via API. The reviewer returns a structured critique, shown in a side panel.

The goal is not to compare answers side by side. The goal is to answer: **"I already have an answer. Should I trust it?"**

## 2. Goals

- A working, polished, small project for a portfolio
- Clear separation of concerns (content script, background worker, UI)
- Privacy-first: the user sees what will be sent and confirms before anything leaves the browser
- Easy to explain in an interview

## 3. Non-goals (v1): do NOT build these

- Multi-model comparison panels
- Confidence scores or percentages (LLM-generated numbers are not calibrated)
- User accounts, backend server, or database
- Claim-by-claim inline annotations
- Web search grounding
- Chrome Web Store publishing
- Support for sites other than chatgpt.com (Claude.ai is a stretch goal)

## 4. User flow

1. User chats on chatgpt.com as normal.
2. A **Cross-check** button appears under each assistant reply.
3. User clicks it.
4. A preview shows exactly what will be sent: the question, the selected reply, and the last N messages (default N = 4). User clicks **Send** or **Cancel**.
5. The side panel opens with a loading state.
6. The reviewer's response appears in sections: Verdict, Issues, Missing points, Strengths.
7. Errors (no key, bad key, rate limit, network) show a clear message in the panel.

## 5. Tech stack

- Chrome Extension, **Manifest V3**
- Plain **JavaScript** (no framework, no build step) unless a step clearly needs more
- `chrome.storage.local` for settings
- `chrome.runtime` messaging between content script and service worker
- Chrome **Side Panel API** for the UI
- Reviewer model accessed through the Gemini API with the user's own key. Default: `gemini-3.8-flash`; model name is configurable. One-time key creation happens in Google AI Studio; reviews happen inside the extension.

## 6. File structure

```
second-look/
├── manifest.json
├── SPEC.md
├── README.md
├── .gitignore
├── src/
│   ├── content/
│   │   ├── content.js        # injects buttons, captures context
│   │   ├── selectors.js      # ALL DOM selectors live here and nowhere else
│   │   └── content.css
│   ├── background/
│   │   └── service-worker.js # receives context, calls the API, returns result
│   ├── sidepanel/
│   │   ├── sidepanel.html
│   │   ├── sidepanel.js
│   │   └── sidepanel.css
│   ├── options/
│   │   ├── options.html
│   │   └── options.js        # API key + model settings
│   └── shared/
│       ├── prompt.js         # reviewer prompt + JSON schema
│       └── constants.js
└── icons/
```

## 7. Architecture rules

1. **All DOM selectors go in `selectors.js`.** Chat sites change their markup often; this keeps fixes to one file.
2. **API calls happen only in the service worker.** The content script never sees the API key.
3. **The API key is stored only in `chrome.storage.local`.** Never hardcoded, never logged, never committed to git.
4. **No conversation content is sent to any API until the user confirms in the preview.** Settings may offer an explicit **Test connection** action that sends only a fixed, harmless test prompt with no conversation data.
5. **The content script handles the page; the side panel handles display.** Keep them decoupled via messages.
6. **No duplicate buttons.** Use a marker attribute on processed messages.
7. **Handle dynamically loaded replies** with a `MutationObserver`.

## 8. Context object

What the content script builds on click:

```json
{
  "question": "the user message immediately before the selected reply",
  "reply": "the selected assistant reply text",
  "history": [
    { "role": "user", "text": "..." },
    { "role": "assistant", "text": "..." }
  ],
  "source": "chatgpt.com",
  "capturedAt": "ISO timestamp"
}
```

`history` holds up to N previous messages (default 4), oldest first, excluding the question and reply. Long messages are truncated to a sensible character limit.

**Known limitation:** the extension only sees the *visible* conversation, not memory, uploaded files, search results, tool outputs, or hidden system instructions the original model may have had.

## 9. Reviewer output schema

The reviewer must respond with JSON only:

```json
{
  "verdict": "correct | mostly_correct | questionable | incorrect",
  "summary": "1-2 sentence overall assessment",
  "issues": [
    { "severity": "high | medium | low", "description": "...", "location": "quote or paraphrase of the affected part" }
  ],
  "missing_points": ["..."],
  "strengths": ["..."]
}
```

Rules for parsing: strip any code fences, `JSON.parse` inside try/catch, and fall back to showing the raw text with a notice if parsing fails.

## 10. Reviewer prompt requirements

The prompt (in `prompt.js`) should instruct the reviewer to:

- Act as a careful, skeptical reviewer of another AI's answer
- Check factual claims, reasoning, calculations, and consistency with the conversation
- Flag unsupported assumptions and note when it is **unsure** instead of guessing
- Not invent problems: if the answer is fine, say so
- Not claim to have verified things it cannot verify (no web access)
- Return only the JSON schema above

**Test this prompt in a plain chat window first**, with 3-4 real answers including at least one deliberately flawed, before wiring it into the extension.

## 11. Settings (options page)

- API key (password field, stored locally)
- Provider and model name
- Number of previous messages to include (default 4)
- A "Test connection" button

Gemini is the only active provider in v1. Existing keys from other providers must never be reused for Gemini. Test connection uses saved settings and sends no chat content. Google account login alone does not configure API access; the user supplies their own Gemini API key.

## 12. Error handling

Show a clear message in the side panel for each of:

- No API key set
- Invalid key (401)
- Rate limited (429)
- Network failure
- Malformed JSON from the reviewer
- Context too long (truncate, and say so)

## 13. Build order

Do one step at a time. Test it and commit before moving on.

1. Skeleton: manifest + content script that logs "loaded"
2. `selectors.js` + helper to find all assistant replies
3. Inject one Cross-check button per reply (MutationObserver, no duplicates)
4. Capture the context object on click
5. Options page storing API key and model
6. Service worker that calls the API and returns raw text
7. Reviewer prompt + JSON output + safe parsing
8. Side panel UI (loading, results, errors)
9. Privacy preview with Send / Cancel
10. Error handling and styling polish
11. Stretch: Claude.ai support, review modes (Verify / Challenge / Code), second reviewer
12. README, demo GIF, limitations section

## 14. Instructions for the AI coding assistant

- Only do the step I ask for. Do not add features or refactor unrelated files.
- Tell me which files you created or changed.
- Keep code simple and commented where non-obvious.
- Follow the architecture rules in section 7.
- If a requirement is ambiguous, ask me one question before coding.
- Never put real API keys in code or examples.

## 15. Definition of done (v1)

- Loads unpacked in Chrome with no errors
- Button appears once under every assistant reply on chatgpt.com, including new ones
- Preview shows exactly what will be sent; nothing sends without confirmation
- Valid key produces a formatted review in the side panel
- All error cases in section 12 show a readable message
- No secrets in the repo; README documents setup and limitations
