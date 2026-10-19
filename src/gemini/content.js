// DOM-only bridge. It never reads cookies, tokens, or unrelated Gemini chats.
let activeReview = null;
const usedReviewIds = new Set();
const visible = element => element && element.getClientRects().length > 0
  && getComputedStyle(element).visibility !== 'hidden';
const allVisible = selector => [...document.querySelectorAll(selector)].filter(visible);
const firstVisible = selector => allVisible(selector)[0];
const normalize = text => text.replace(/\s+/g, ' ').trim();

function geminiStatus() {
  const composer = firstVisible(GEMINI_SELECTORS.composer);
  const signedIn = Boolean(firstVisible(GEMINI_SELECTORS.account));
  let reason = '';
  if (!signedIn) reason = 'Sign in to your Google account on the Gemini tab, then click Continue in Second Look.';
  else if (!composer) reason = 'Gemini is not ready. Finish any setup on its tab, then click Continue.';
  else if (firstVisible(GEMINI_SELECTORS.stop)) reason = 'Gemini is already generating a response. Wait for it to finish.';
  else if (composer.textContent.trim() || allVisible(GEMINI_SELECTORS.response).length || allVisible(GEMINI_SELECTORS.user).length) {
    reason = 'This Gemini tab has a draft or conversation. Start a new chat there, then click Continue. Second Look will not overwrite it.';
  }
  return {signedIn, hasComposer: Boolean(composer), ready: !reason, reason};
}
function report(type, data = {}) {
  return chrome.runtime.sendMessage({type, ...data}).catch(() => {});
}
function stopWatching() {
  if (!activeReview) return;
  activeReview.cancelled = true;
  clearInterval(activeReview.timer);
  activeReview.observer?.disconnect();
}
function fail(job, error) {
  if (job.cancelled) return;
  stopWatching();
  report('GEMINI_ERROR', {id:job.id, error});
}
async function runReview(job, prompt) {
  try {
    const status = geminiStatus();
    if (!status.ready) { fail(job, status.reason); return; }
    const composer = firstVisible(GEMINI_SELECTORS.composer);
    composer.focus();
    // Insert through the editing API so Gemini's Quill editor receives an input event.
    // No clipboard access or framework/private API access is needed.
    if (!document.execCommand('insertText', false, prompt)) {
      fail(job, 'Could not fill Gemini’s editor. Nothing was submitted.'); return;
    }
    // Gemini may replace/reformat the editor after input. Re-query it and wait
    // for two matching reads instead of inspecting the stale original node.
    let matchingReads = 0;
    for (let attempt = 0; attempt < 30 && matchingReads < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (job.cancelled) return;
      const currentEditor = firstVisible(GEMINI_SELECTORS.composer);
      matchingReads = currentEditor && normalize(currentEditor.innerText || currentEditor.textContent) === normalize(prompt)
        ? matchingReads + 1 : 0;
    }
    if (matchingReads < 2) {
      fail(job, 'Gemini’s draft changed while it was being filled. Nothing was submitted; check its tab.'); return;
    }
    const send = firstVisible(GEMINI_SELECTORS.send);
    if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') {
      fail(job, 'Gemini’s Send button is unavailable. Check its tab; the review prompt is still a draft.'); return;
    }
    let lastText = '', stableSince = Date.now();
    const startedAt = Date.now();
    const check = () => {
      if (job.cancelled) return;
      if (Date.now() - startedAt > 170000) {
        fail(job, 'Gemini did not finish the review. Check its tab for a usage limit, sign-in request, or response. Nothing was resubmitted.'); return;
      }
      const replies = allVisible(GEMINI_SELECTORS.response);
      const questions = allVisible(GEMINI_SELECTORS.user);
      if (replies.length > 1 || questions.length > 1) {
        fail(job, 'The Gemini conversation changed during the review. Its response was not imported.'); return;
      }
      const reply = replies[0];
      if (!reply) return;
      const code = reply.querySelector(GEMINI_SELECTORS.code);
      const body = reply.querySelector(GEMINI_SELECTORS.body);
      const raw = (code?.textContent || body?.innerText || body?.textContent || '').trim();
      if (raw.length > 80000) { fail(job, 'Gemini’s response is too large to display. Read it in the Gemini tab.'); return; }
      if (raw !== lastText) { lastText = raw; stableSince = Date.now(); return; }
      // Stable text alone can be a pause in streaming. Require Gemini's completed reply controls too.
      if (raw && questions.length === 1 && Date.now() - stableSince >= 1500
          && !firstVisible(GEMINI_SELECTORS.stop) && visible(reply.querySelector(GEMINI_SELECTORS.copy))) {
        stopWatching();
        report('GEMINI_RESULT', {id:job.id, raw});
      }
    };
    job.observer = new MutationObserver(check);
    job.observer.observe(document.body, {childList:true, subtree:true, characterData:true});
    job.timer = setInterval(check, 500);
    send.click(); // Exactly one click. Never retry an uncertain submission.
    report('GEMINI_PROGRESS', {id:job.id});
  } catch {
    fail(job, 'The Gemini page changed unexpectedly. Check its tab before starting another review.');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'GEMINI_STATUS') { respond(geminiStatus()); return false; }
  if (message?.type === 'GEMINI_CANCEL' && message.id === activeReview?.id) {
    stopWatching(); respond({ok:true}); return false;
  }
  if (message?.type !== 'GEMINI_START' || typeof message.id !== 'string' || typeof message.prompt !== 'string'
      || message.prompt.length > 32000 || usedReviewIds.has(message.id)
      || (activeReview && !activeReview.cancelled)) return false;
  const status = geminiStatus();
  if (!status.ready) { respond({accepted:false}); return false; }
  usedReviewIds.add(message.id);
  activeReview = {id:message.id, cancelled:false};
  respond({accepted:true});
  runReview(activeReview, message.prompt);
  return false;
});
report('GEMINI_READY');
