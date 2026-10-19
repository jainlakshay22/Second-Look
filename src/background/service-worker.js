importScripts('../shared/settings.js', '../shared/review.js', 'gemini.js');
const storageReady = Promise.all([
  restrictSettingsStorage(),
  chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
]).then(async () => {
  await chrome.storage.local.remove(['geminiHome','browserSetup']);
  await chrome.storage.session.remove('setupTabId');
});
let queue = Promise.resolve();
let testing = false;
function serial(task) {
  const result = queue.then(async () => { await storageReady; return task(); });
  queue = result.catch(() => {});
  return result;
}
async function save(review) { await chrome.storage.session.set({review}); }
async function current() {
  const {review = null} = await chrome.storage.session.get('review');
  // Browser-mode reviews cannot continue after the switch to API mode.
  if (review && review.transport !== 'api') {
    await chrome.storage.session.remove('review');
    return null;
  }
  if (review?.phase === 'waiting' && Date.now() > review.deadline) {
    review.phase = 'error';
    review.error = 'The review was interrupted or timed out. Cross-check the answer again to retry. Nothing was resubmitted automatically.';
    await save(review);
  }
  return review;
}
function trustedPage(sender, path) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(path);
}
function fromChat(sender) {
  try { return sender.id === chrome.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id)
    && new URL(sender.url).origin === 'https://chatgpt.com'; } catch { return false; }
}
function safeError(error) {
  return error instanceof GeminiError ? error.message : 'The extension could not complete the review. Cross-check the answer again to retry.';
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;
  const panel = trustedPage(sender, 'src/sidepanel/sidepanel.html');
  const options = trustedPage(sender, 'src/options/options.html');
  const chat = fromChat(sender);
  if (options && message.type === 'TEST_GEMINI_CONNECTION') {
    if (testing) { respond({error:'A connection test is already running.'}); return false; }
    testing = true;
    storageReady.then(() => generateGeminiText('Reply with exactly OK.', {maxOutputTokens:1024,connectionTest:true}))
      .then(() => respond({ok:true}), error => respond({error:safeError(error)}))
      .finally(() => { testing = false; });
    return true;
  }
  const allowed = (chat && ['OPEN_PREVIEW','CAPTURE_REVIEW','GET_CAPTURE_SETTINGS'].includes(message.type))
    || (panel && ['GET_REVIEW','SEND_REVIEW','CANCEL_REVIEW','API_REVIEW_RESULT','API_REVIEW_ERROR'].includes(message.type));
  if (!allowed) return false;
  // Chrome must see sidePanel.open directly in the original click's event handler.
  const opened = message.type === 'OPEN_PREVIEW'
    ? chrome.sidePanel.open({windowId:sender.tab.windowId}).then(() => true, () => false) : null;
  serial(async () => {
    if (message.type === 'OPEN_PREVIEW') return {ok:await opened};
    if (message.type === 'GET_CAPTURE_SETTINGS') {
      const {historyCount} = await chrome.storage.local.get({historyCount:SETTINGS_DEFAULTS.historyCount});
      return {historyCount:isValidHistoryCount(historyCount) ? historyCount : 4};
    }
    let review = await current();
    if (message.type === 'CAPTURE_REVIEW') {
      if (review?.phase === 'waiting') return {error:'A review is already in progress. Finish it or stop it in the side panel first.'};
      if (!validContext(message.context)) return {error:'Could not read this answer. Refresh ChatGPT and try again.'};
      review = {id:crypto.randomUUID(),transport:'api',phase:'preview',context:message.context,
        selected:suggestedHistory(message.context),createdAt:Date.now()};
      await save(review); return {ok:true};
    }
    if (message.type === 'GET_REVIEW') return {review};
    if (!review || message.id !== review.id) return {error:'This review has changed. Reopen the preview.'};
    if (message.type === 'SEND_REVIEW') {
      if (review.phase !== 'preview') return {error:'This review has already been sent or cancelled.'};
      let prompt;
      try { prompt = buildReviewPrompt(review.context,message.selected); }
      catch { return {error:'The selected context is invalid. Capture the answer again.'}; }
      if (prompt.length > REVIEW_LIMIT) return {error:'This prompt is too long. Deselect some earlier messages before sending.'};
      // Persist before calling Google so repeated clicks cannot create duplicate requests.
      review = {...review,phase:'waiting',selected:message.selected,deadline:Date.now()+190000};
      await save(review);
      // Only the confirming trusted panel receives the request. Never replay it on GET_REVIEW.
      return {ok:true,id:review.id,prompt};
    }
    if (['API_REVIEW_RESULT','API_REVIEW_ERROR'].includes(message.type)) {
      if (review.phase !== 'waiting') return {error:'This review is no longer waiting.'};
      if (message.type === 'API_REVIEW_ERROR') {
        review.phase = 'error';
        review.error = typeof message.error === 'string' ? message.error.slice(0,500) : 'The review failed. Cross-check again to retry.';
      } else {
        if (typeof message.raw !== 'string' || message.raw.length > 80000) return {error:'Invalid review response.'};
        review.phase = 'done';review.raw = message.raw;review.result = parseReview(message.raw);
      }
      await save(review);return {ok:true};
    }
    if (message.type === 'CANCEL_REVIEW') {
      const sent = review.phase !== 'preview';
      await save({id:review.id,transport:'api',phase:'cancelled',notice:sent
        ? 'Stopped waiting. Google may already have processed the request; API usage may still apply.'
        : 'Cancelled. Nothing was sent to Gemini.'});
      return {ok:true};
    }
  }).then(respond, () => respond({error:'The extension could not complete this action. Reload it and try again.'}));
  return true;
});
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
