# Second Look: Spec

A second-opinion button for ChatGPT answers, using the Gemini API and a locally saved API key. The user reverted the browser-login experiment to API-only operation. This replaces the browser-account setup and automation plan.

## User flow

1. Setup accepts a Gemini API key, model, and history count. Save locally; optionally test with a small synthetic prompt.
2. ChatGPT replies have one Cross-check button, including dynamically loaded replies.
3. Cross-check opens the side panel and captures the question, reply, and up to N prior messages (default 4).
4. Local word overlap and follow-up hints suggest context. Users can adjust the selection and inspect the exact prompt.
5. Only Send submits the confirmed prompt once to Google's API from the trusted side panel, after worker authorization.
6. The panel displays progress, then verdict, summary, issues, missing points, and strengths. No Gemini tabs or website login.
7. Cancel clears the preview or aborts an in-flight request. Already submitted requests may still be processed/billed. Never automatically retry.

## Architecture

- Manifest V3, plain JavaScript, no build step. All DOM query selectors in root `selectors.js`.
- Only ChatGPT has a content script. Host access for API requests is restricted to `https://generativelanguage.googleapis.com/*`.
- The worker validates sender origins, trusted extension pages, and review IDs. A content script cannot authorize an API call or obtain the key.
- API key/model/settings use trusted-only local storage. Context/results use trusted-only session storage. Never log or commit credentials, and never put keys in URLs.
- One local installation uses its saved key. A centrally funded public distribution would require a backend proxy; not part of this step.
- Persist state before API submission, reject duplicate Send, abort on cancellation, and ignore stale results. Never replay authorized prompts after worker or panel restart.
- Network calls must not block cancellation/panel polling. Connection tests run in the worker with a 25-second limit. Reviews run in the trusted panel with a 90-second header limit and 90-second stream limit. Closing the panel cancels the local request. Persist authorization in the worker, reject late results, and expire abandoned waiting state.
- Show safe, actionable errors for credentials, quota, unavailable models, network failures, timeouts, blocked and incomplete responses. Do not display provider payloads that could contain sensitive details.
- Render results with textContent. Validate structured output; malformed results fall back to plain text.

## Context and output

Capture: `{question, reply, history:[{role,text}], source:"chatgpt.com", capturedAt}`. History excludes the selected question/reply, stays oldest first, and is limited to 0–20 messages. Each message is capped at 8,000 characters with an explicit marker. Complete prompt maximum: 32,000 characters.

Review: `{verdict, summary, issues:[{severity,description,location}], missing_points:[], strengths:[]}`. Verdict: correct, mostly_correct, questionable, or incorrect. Severity: high, medium, or low. Request JSON schema output and validate again locally.

Reviewer checks facts, reasoning, calculations, code, consistency, and omissions. State uncertainty, avoid invented faults and unsupported claims of verification, treat captured content as untrusted data, and use no tools/actions. Context suggestions are heuristics, not guaranteed minimal or complete context.

## Development rules

Keep changes within the requested step or approved product change. Test and commit each step. Explain changed files. Use safe mock data for tests and never commit credentials. Do not add multi-model comparison, inline annotations, a backend/database, or publishing without a request.

## Completed polish step

- Distinct verdict treatments and severity-labelled issue cards; meaning never relies on color alone.
- Visible waiting state with reduced-motion support and clear guidance to keep the panel open.
- Error recovery and Review again return to the existing captured context with a fresh review ID. Retain selected messages; discard the previous result/error. Send must be confirmed again. Ignore late messages for the old ID.
- Preview, waiting, and cancelled reviews cannot be reopened through this recovery action. Cancel continues to clear captured context.

## v2 — Grounded claim verification

This section defines planned v2 work; it does not change the implemented v1 behavior. The API-only setup and locally saved user key remain. For v2 verification, the provider's web search/grounding tool is allowed, replacing v1's no-tools restriction for this step only. Inline annotations are allowed only on the side panel's copy of the answer.

### Goals and behavior

1. **Claim-level verification.** Extract individually checkable factual claims from the selected answer. Label each `supported`, `contradicted`, or `unverified`, with a short reason and source URLs when available. Separate compound claims where practical. Opinions, preferences, and instructions are not automatically factual claims; an answer with no checkable claims may return an empty claims list.
   - `supported`: retrieved evidence supports the claim as stated, including its scope and relevant date.
   - `contradicted`: retrieved evidence directly conflicts with the claim. Explain the conflict or correction.
   - `unverified`: sufficient evidence is unavailable, inaccessible, conflicting, or inconclusive. Missing search results are not proof that a claim is false. Model recollection alone is not grounded support.
2. **Search grounding.** Use the configured provider's web search/grounding tool during verification. Prefer direct, authoritative sources and preserve the provider's grounding metadata. Show a source list and the sources attached to each claim. Do not invent URLs, infer citations from model memory, or attach a source that does not support the stated reason. If grounding is unavailable or fails, show that clearly; do not silently present an ungrounded review as verified.
3. **Inline highlighting.** Show the captured answer in the side panel and highlight `contradicted` and `unverified` spans with distinct treatments and visible labels. Hover, keyboard focus, or click reveals the claim's label, reason, and source links; click/tap keeps the comment open until dismissed. Unverified means uncertain, not incorrect. Do not alter ChatGPT's page or rely on color alone.
4. **Small evaluation suite.** Add a repository-root `/eval` folder with labelled examples, a runner, and a report measuring catch rate and false-alarm rate. Keep credentials and real private conversations out of fixtures and reports.

### Privacy, grounding, and rendering rules

- Keep the existing preview and explicit Send confirmation. Explain that verification uses provider web search and may generate search queries from the selected text. Show the exact review input before submission; display actual search queries afterward when returned by the provider, rather than pretending they are known in advance.
- Treat the captured conversation and retrieved web content as untrusted evidence, never as instructions. Allow only the search/grounding capability needed for verification; no arbitrary tool actions or website automation.
- Source entries must come from the actual grounding response. The extension assigns stable IDs within each review and checks claim-to-source references against that response. Never accept a model-generated URL merely because it looks valid.
- Validate output locally. Create highlighted spans using DOM elements and textContent, never provider-supplied HTML. Permit only validated HTTP(S) source links, opened with `noopener noreferrer`.
- Anchor claims to the exact captured answer string used in the request, before any display formatting. Offsets use JavaScript UTF-16 code units: `start` is inclusive and `end` is exclusive. Require `answer.slice(start, end) === quote`, with valid bounds and no split surrogate pairs. Do not search for and highlight an arbitrary duplicate occurrence when anchoring fails.
- Several claims may share or overlap a span. Merge overlapping highlight regions and make all associated comments available. If a span is invalid, keep the claim in the claim list with an unavailable-location notice instead of highlighting the wrong text.
- Preserve v1's summary, reasoning/code issues, missing points, and strengths. The overall verdict is a qualitative review, not a confidence score or a substitute for individual claim labels. The same captured text and selected context remain available in a retry preview; another Send confirmation is required.

### v2 JSON schema

This is the canonical application output contract. Implement a provider-compatible schema or validation/formatting stage if the chosen model cannot combine this schema with grounding in a single request. A formatting stage must preserve the original evidence and source references; it must not perform ungrounded re-verification.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "verdict", "summary", "grounding", "claims", "sources", "issues", "missing_points", "strengths"],
  "properties": {
    "schema_version": {"const": 2},
    "verdict": {"enum": ["correct", "mostly_correct", "questionable", "incorrect"]},
    "summary": {"type": "string", "minLength": 1},
    "grounding": {
      "type": "object",
      "additionalProperties": false,
      "required": ["status", "reason", "search_queries"],
      "properties": {
        "status": {"enum": ["completed", "partial", "unavailable", "not_needed"]},
        "reason": {"type": "string"},
        "search_queries": {"type": "array", "items": {"type": "string"}, "uniqueItems": true}
      }
    },
    "claims": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "claim", "span", "label", "reason", "source_ids"],
        "properties": {
          "id": {"type": "string", "minLength": 1},
          "claim": {"type": "string", "minLength": 1},
          "span": {
            "type": "object",
            "additionalProperties": false,
            "required": ["start", "end", "quote"],
            "properties": {
              "start": {"type": "integer", "minimum": 0},
              "end": {"type": "integer", "minimum": 1},
              "quote": {"type": "string", "minLength": 1}
            }
          },
          "label": {"enum": ["supported", "contradicted", "unverified"]},
          "reason": {"type": "string", "minLength": 1},
          "source_ids": {"type": "array", "items": {"type": "string", "minLength": 1}, "uniqueItems": true}
        }
      }
    },
    "sources": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "title", "url"],
        "properties": {
          "id": {"type": "string", "minLength": 1},
          "title": {"type": "string", "minLength": 1},
          "url": {"type": "string", "format": "uri", "pattern": "^https?://"}
        }
      }
    },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "description", "location"],
        "properties": {
          "severity": {"enum": ["high", "medium", "low"]},
          "description": {"type": "string"},
          "location": {"type": "string"}
        }
      }
    },
    "missing_points": {"type": "array", "items": {"type": "string"}},
    "strengths": {"type": "array", "items": {"type": "string"}}
  }
}
```

Additional semantic validation beyond JSON shape:

- Claim IDs and source IDs are unique within their respective lists. Every `source_ids` entry resolves to a source in this review and to provider grounding metadata.
- `supported` and `contradicted` claims require at least one relevant grounded source. `unverified` claims may have no sources or cite inconclusive/conflicting evidence. Unsupported evidence assertions must be flagged as invalid or downgraded to `unverified`, never silently accepted.
- `grounding.status` is derived from observed provider execution, not only the reviewer's assertion. `completed` means the grounding step completed, not that every claim was verified. `partial` or `unavailable` requires a user-readable reason. `not_needed` is valid only when no checkable factual claims were found.
- An unavailable grounding step cannot produce supported/contradicted claims. A partial step may retain labels backed by evidence actually retrieved; remaining claims stay unverified. An empty `search_queries` list can mean that the provider did not expose queries; it does not by itself imply search was unused.
- Invalid or incomplete output must show an explicit review/grounding error or an unverified plain-text fallback, never a successful grounded-verification badge. Apply bounded output size and claim/source counts during implementation; report truncation or incomplete coverage explicitly.

### Evaluation suite (`/eval`)

Start with a small, manually curated fixture set covering correct facts, deliberate falsehoods, mixed answers, ambiguous/time-sensitive statements, unsupported claims, repeated quotes, overlapping claims, and answers without factual assertions. Each case records a stable ID, question, answer, optional context, gold claims/anchor spans, expected truth labels, and reference evidence with an as-of date where relevant. Include source-unavailable and grounding-failure fixtures.

- **Catch rate** = gold false claims correctly labelled `contradicted` / all gold false claims.
- **False-alarm rate** = gold true claims incorrectly labelled `contradicted` / all gold true claims.
- `unverified` is an abstention, not a contradiction. A false claim labelled unverified or omitted is a missed catch. Report unverified and omission counts separately so abstention cannot make performance look artificially strong.
- Also report extraction coverage, unverified labels on gold true claims, false claims incorrectly labelled supported, and invalid output/source/span counts. Gold unknown/ambiguous claims are reported separately and excluded from the two primary rate denominators. A zero denominator is `N/A`, not zero.
- Match predictions to gold claims by annotated spans and claim meaning, not reviewer-generated IDs. Count each gold claim once; do not reward duplicate predictions. Document the matching rule, review ambiguous matches manually, and report unmatched predictions separately.
- Keep deterministic validation/highlight checks using recorded or synthetic grounded responses separate from live grounded-model runs. Live runs are explicit because they incur API/search usage and can vary with the web. Report model ID, prompt/schema version, run date, fixture version, numerators, denominators, and per-case failures. Do not store API keys.
- Compare v2 runs against a recorded baseline on the same fixtures. Treat small-suite rates as development measurements, not proof of general reliability or per-answer confidence.

### v2 non-goals

- No confidence percentages, probability scores, or certainty meters on reviews or claims. Aggregate evaluation rates are test metrics, not model confidence.
- No Second Look user accounts, login flow, OAuth setup, or subscription/account management. Continue using a locally supplied API key.
- No backend/database, centrally shared embedded API key, multi-model comparison, or Chrome Web Store publishing in this scope.
- No inline changes to the original ChatGPT page, autonomous browsing outside provider grounding, or guarantee that every claim can be verified.

### v2 build order

Implement one step at a time, test it, and commit before proceeding. This spec update alone authorizes no implementation work.

1. **Contract and fixtures:** define the v2 schema, claim/span/source validation rules, small `/eval` fixture set, and metric/matching definitions. Establish deterministic tests before adding network calls.
2. **Claim extraction:** extract atomic factual claims from the captured answer, attach exact spans, and validate coverage/anchors. Present extraction as unverified until evidence is checked.
3. **Grounded verification:** verify the selected Gemini model's current grounding and structured-output capabilities; integrate the provider's search tool, retain grounding metadata, and map evidence to claim IDs. Use an extraction → grounded verification → formatting sequence only where needed for compatibility. Add clear unavailable/partial/error handling and retain Send consent.
4. **Claim and source UI:** display labels, reasons, and validated source links in the side panel; show grounding status and incomplete coverage explicitly. Preserve the existing overall review sections.
5. **Inline highlighting:** render the side panel's answer copy with validated spans, overlap handling, and accessible hover/focus/click comments. Test repeated text, Unicode, long answers, malformed spans, and unsafe source URLs.
6. **Evaluate and refine:** run the deterministic suite and explicitly initiated live evaluations, calculate catch and false-alarm rates plus coverage/abstentions, inspect failures, and compare to the baseline. Fix failures and rerun affected checks.
7. **Document and demo:** update setup/model requirements, grounding costs and privacy disclosure, limitations, evaluation results, and a short portfolio demonstration. Do not publish automatically.
