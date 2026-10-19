# Verify-claims evaluation

This suite contains 25 synthetic cases: 6 correct factual answers, 6 answers with planted factual errors, 2 correct math answers, 4 wrong math answers, 2 correct Python snippets, and 5 buggy Python snippets. Mixed answers have separate correct and incorrect claim labels. Ground truth includes exact UTF-16 spans, `is_wrong`, a correction or rationale, and optional equivalent code anchors in `accepted_quotes`.

## Run

Use Node.js 20 or newer. No npm packages are needed. From the repository root, in your existing zsh terminal:

```sh
read -s 'GEMINI_API_KEY?Gemini API key: '
export GEMINI_API_KEY
node eval/run-eval.js
unset GEMINI_API_KEY
node eval/score.js
```

The silent prompt keeps the key out of shell history and terminal output. Do not put it in source code, commit it, or pass it on the command line. The runner reads only `GEMINI_API_KEY`; it does not read Chrome storage or `.env` files. Scoring needs no key and makes no requests.

The default model comes from `src/shared/settings.js`. To override it before running:

```sh
export GEMINI_MODEL=gemini-3.5-flash-lite
export EVAL_DELAY_MS=4000
export EVAL_GROUNDING=true
```

Grounding defaults to **on** for this suite, independently of the Chrome setting. That allows evidence-backed verdicts using the extension's current Search integration. `EVAL_GROUNDING=false` is available for a diagnostic run, but the current verification pipeline downgrades claims without retrieved sources to `unverified`; such a run does not measure grounded verification performance. The client's existing model compatibility checks apply.

Running the script sends 25 synthetic question/answer pairs sequentially to Google and may incur API and Search charges. It uses the real `buildReviewPrompt` / `generateGeminiReview` implementation and local validation from the extension. Ground-truth labels, corrections, accepted anchors, and expected answers are never sent. Neither generated code nor fixture code is executed.

`results.json` is saved in this folder before the first request and after each case, using a temporary file and rename. It includes model, timestamps, fixture hash/version, hashes of the shared source files, each case's status, elapsed time, and `{review, grounding}` results. It never saves the key, request headers, environment, or raw exception/provider-error messages. Generated results are ignored by Git.

Each run **overwrites** the previous results; copy `results.json` elsewhere first if keeping a baseline. Paths are relative to the scripts, so running them from another working directory also works.

## Quota, interruptions, and failures

There are no automatic retries. Requests are separated by four seconds by default; `EVAL_DELAY_MS` accepts 0–60000. This delay does not guarantee compliance with your project's token or daily limits.

On HTTP 400, 401, 403, 404, or 429 the run stops, saves the error and earlier successes, and leaves later cases as `not_run`. In particular, a quota error will not trigger 24 more attempts. Other per-case failures are recorded and evaluation continues. Ctrl+C aborts the active request and preserves partial results. Failed, stopped, or interrupted runs exit with status 1. Check usage/quota before running again; a new run starts from the first case.

## Scoring

```sh
node eval/score.js
# Optional: save the printed Markdown table.
node eval/score.js > /tmp/second-look-eval-report.md
```

- **Catch rate:** gold wrong claims assigned at least one `contradicted` prediction / all gold wrong claims.
- **False-alarm rate:** gold correct claims assigned at least one `contradicted` prediction / all gold correct claims.
- `unverified` is an abstention. It does not catch a planted error or create a false alarm. Omitted claims are also missed catches.
- Missing, failed, and invalid cases remain in the denominators and count as omissions. The report explicitly warns on partial/failed runs: do not interpret their low false-alarm rates as complete-run performance.
- A zero denominator prints `N/A`. The table also reports extraction coverage, omissions, abstentions, wrong claims marked supported, conflicting predictions, unmatched/ambiguous predictions, and failures, plus per-case rows.

### Matching rule and limitations

Prediction IDs are ignored. The scorer locates **all exact occurrences** of each predicted quote in the answer. It assigns that prediction only if its span contains, or is contained by, an annotated gold span (including an explicitly authored equivalent code anchor), and it matches **exactly one** gold claim. Matches touching multiple gold claims are ambiguous and contribute to neither; unrelated predictions are unmatched. Mere partial overlap, paraphrases, case changes, and whitespace normalization do not match.

Each gold claim is counted once regardless of duplicate predictions. Any assigned contradiction takes precedence; if a gold claim also receives another verdict, the conflict is reported. Otherwise supported takes precedence over unverified. These rules are deterministic lexical alignment, **not a semantic judge**: a too-short quote may align imperfectly, and a broad quote covering mixed true/false claims is deliberately left ambiguous. Inspect ambiguous, conflicting, omitted, and unmatched cases manually before interpreting the rates. Accepted code anchors are limited to statements explicitly annotated as describing that behavior.

The scorer revalidates exact quotes and review structure and checks claim URLs against the saved grounding source list. Invalid reviews are failed cases. It requires the current `cases.json` hash to equal the recorded hash; restore the original fixture or rerun after edits. Source-code hashes in the result identify which prompt/client produced a run; compare baselines only on the same fixtures, model, prompt, grounding setting, and matching rule.

This small suite is a development check, not a reliability guarantee. It uses stable facts and hand-checkable arithmetic/code counterexamples. Search results and model output can vary. The current verifier requires matching retrieved source URLs for supported/contradicted labels even for math and code, so those cases may expose abstention or citation-matching weaknesses; the evaluator intentionally does not loosen that rule.

## Offline tests

```sh
node --test eval/eval.test.cjs
```

These tests use mocked Gemini streams and temporary output files. They check fixture anchors, claim scoring, duplicate/ambiguous handling, prompt privacy, saved results, and stopping after quota errors. They make no live API calls and consume no quota.
