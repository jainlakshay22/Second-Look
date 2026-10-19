# Second Look

Cross-check ChatGPT answers with Gemini, source-backed claim reviews, and inline highlights—all in a Chrome side panel.

Second Look adds a **Cross-check** button to ChatGPT replies. Choose **Review** for an overall assessment or **Verify claims** to check individual factual claims. Inspect the answer and recent context before sending, then explore verdicts, explanations, and sources beside the original conversation. It uses your own Gemini API key.

> **Demo GIF placeholder:** Cross-check → choose Verify claims → send → click a highlighted claim to see its explanation and sources.
<!-- Replace the placeholder above with the demo when recorded: ![Second Look demo](docs/demo.gif) -->

## Quick install

1. Download or clone this repository. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the repository folder containing `manifest.json`.
3. Open Second Look's popup → **API key / Settings**, enter your Gemini API key, and click **Save settings**. Optionally use **Test connection**.
4. For source-backed verification, enable **Use Google Search for claim verification** in Settings and save. It is off by default; API and Search usage may incur charges.
5. Refresh ChatGPT, click **Cross-check** below a reply, choose a mode, review the selected context, and click **Send to Gemini**.

After updating the extension, click **Reload** at `chrome://extensions`, refresh ChatGPT, and reopen the side panel.

## How it works

1. **Claim extraction.** In Verify claims mode, Gemini extracts factual claims and copies an exact quote for each one. The extension validates those quotes against the selected answer and labels claims **supported**, **contradicted**, or **unverified**.
2. **Search grounding.** When enabled, Gemini uses Google Search during verification. The extension retains provider source metadata and checks claim citations against the returned URLs. Claims without matching evidence remain unverified; with grounding off, the current verifier cannot independently verify them.
3. **Inline highlights.** The panel renders the answer as safe text and colors exact quote matches by verdict. Click a highlight to read the explanation and open source links. Overlapping claims remain accessible; unmatched quotes are listed below the answer.

**Review** keeps the general assessment: an overall verdict, issues, missing points, and strengths. Verification is an aid to checking an answer, not a guarantee that every claim is correct.

For data handling, permissions, context limits, cancellation, and timeouts, see [Privacy and technical details](docs/DETAILS.md).

## Evaluation

The [evaluation suite](eval/README.md) contains **25 synthetic cases** covering correct facts, planted factual errors, wrong math, and short buggy code, with **16 wrong and 15 correct gold claims**. Catch rate measures wrong claims flagged as contradicted; false-alarm rate measures correct claims flagged as contradicted.

Latest saved run: **20 October 2026**, `gemini-3.5-flash-lite`, Google Search on, fixture version 1.

**Run stopped by quota; performance remains unmeasured.** The first request returned HTTP 429, so **0/25 cases completed**, one failed, and 24 were not run. The scorer counts missing results as omissions. Its zero rates below do **not** demonstrate either accuracy or an absence of false alarms; a completed run is still needed.

| Metric | Result |
| --- | ---: |
| Catch rate (wrong claims contradicted) | 0/16 (0.0%) |
| False-alarm rate (correct claims contradicted) | 0/15 (0.0%) |
| Extraction coverage | 0/31 (0.0%) |
| Omitted gold claims | 31 |
| Unverified gold claims | 0 |
| Correct claims marked unverified | 0 |
| Wrong claims marked supported | 0 |
| Unmatched / ambiguous predictions | 0 / 0 |
| Gold claims with conflicting predictions | 0 |
| Failed cases / not run | 1 / 24 |
| Invalid review/source outputs | 0 |

This is a snapshot of the local `eval/results.json`; generated results are not committed. To run a fresh evaluation and print the full report:

```sh
# Set GEMINI_API_KEY in your environment first; see eval/README.md.
node eval/run-eval.js
node eval/score.js
```

Live evaluations consume API/Search quota and may incur charges. See the [evaluation guide](eval/README.md) for secure key entry, matching rules, failure handling, and how to interpret the rates.

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

Run the extension and evaluation tests locally (Node.js 20+):

```sh
node --test tests/*.test.cjs eval/eval.test.cjs
```

Tests use synthetic text, fake credentials, and mocked Chrome/API responses. They consume no API quota. After changing the API integration, manually check Settings → Test connection, preview cancellation, and a completed review.
