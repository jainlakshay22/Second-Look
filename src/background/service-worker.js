importScripts('../shared/settings.js', '../shared/review.js');
const storageReady = Promise.all([
  restrictSettingsStorage(),
  chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}),
]);
const busyPhases = ['opening', 'needs_attention', 'sending', 'waiting'];
let queue = Promise.resolve();
function serial(task) {
  const result = queue.then(async () => { await storageReady; return task(); });
  queue = result.catch(() => {});
  return result;
}
async function save(review) { await chrome.storage.session.set({review}); }
async function current() {
  const {review = null} = await chrome.storage.session.get('review');
  if (review && busyPhases.includes(review.phase) && Date.now() > review.deadline) {
    review.phase = 'error';
    review.error = 'Gemini did not finish in three minutes. Check the Gemini tab for sign-in, usage limits, or a response. Nothing will be resubmitted automatically.';
    delete review.prompt;
    await save(review);
  }
  return review;
}
function trustedPage(sender, path) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(path);
}
function fromSite(sender, origin) {
  try { return sender.id === chrome.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id)
    && new URL(sender.url).origin === origin; } catch { return false; }
}
async function inspectAndStart(review) {
  if (!review || review.phase !== 'opening' || !Number.isInteger(review.geminiTabId)) return;
  let status;
  try { status = await chrome.tabs.sendMessage(review.geminiTabId, {type: 'GEMINI_STATUS'}); }
  catch { return; } // The content script may still be loading; its ready message retries this.
  if (!status?.ready) {
    review.phase = 'needs_attention';
    review.error = status?.reason || 'Open the Gemini tab and finish signing in, then click Continue here.';
    await save(review);
    return;
  }
  review.phase = 'sending'; // Persist before sending; never automatically retry an uncertain submission.
  delete review.error;
  await save(review);
  try {
    const response = await chrome.tabs.sendMessage(review.geminiTabId, {
      type: 'GEMINI_START', id: review.id, prompt: review.prompt,
    });
    if (!response?.accepted) throw new Error('Not accepted');
  } catch {
    review.phase = 'error';
    review.error = 'Could not start the review. Check the Gemini tab before trying again; the prompt may already have been submitted.';
    delete review.prompt;
    await save(review);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;
  const panel = trustedPage(sender, 'src/sidepanel/sidepanel.html');
  const options = trustedPage(sender, 'src/options/options.html');
  const chat = fromSite(sender, 'https://chatgpt.com');
  const gemini = fromSite(sender, 'https://gemini.google.com');
  // Open synchronously from the original click so Chrome preserves the user gesture.
  let opened;
  if (message.type === 'OPEN_PREVIEW' && chat) {
    opened = chrome.sidePanel.open({windowId: sender.tab.windowId}).then(() => true, () => false);
  }
  const allowed = (chat && ['OPEN_PREVIEW','CAPTURE_REVIEW','GET_CAPTURE_SETTINGS'].includes(message.type))
    || ((panel || options) && ['OPEN_GEMINI_SETUP','CHECK_GEMINI_SETUP'].includes(message.type))
    || (panel && ['GET_REVIEW','SEND_REVIEW','CONTINUE_REVIEW','CANCEL_REVIEW','SHOW_GEMINI'].includes(message.type))
    || (gemini && ['GEMINI_READY','GEMINI_PROGRESS','GEMINI_RESULT','GEMINI_ERROR'].includes(message.type));
  if (!allowed) return false;
  serial(async () => {
    if (message.type === 'OPEN_PREVIEW') return {ok: await opened};
    if (message.type === 'GET_CAPTURE_SETTINGS') {
      const {historyCount} = await chrome.storage.local.get(SETTINGS_DEFAULTS);
      return {historyCount: isValidHistoryCount(historyCount) ? historyCount : 4};
    }
    if (message.type === 'OPEN_GEMINI_SETUP') {
      const {geminiHome} = await chrome.storage.local.get(SETTINGS_DEFAULTS);
      const tab = await chrome.tabs.create({url: geminiHomeFor(geminiHome) || SETTINGS_DEFAULTS.geminiHome, active: true});
      await chrome.storage.session.set({setupTabId: tab.id});
      return {ok: true};
    }
    if (message.type === 'CHECK_GEMINI_SETUP') {
      const {setupTabId} = await chrome.storage.session.get('setupTabId');
      if (!Number.isInteger(setupTabId)) return {error: 'Click Open Gemini first, then sign in there.'};
      let tab, status;
      try {
        tab = await chrome.tabs.get(setupTabId);
        status = await chrome.tabs.sendMessage(setupTabId, {type: 'GEMINI_STATUS'});
      } catch { return {error: 'Open Gemini, finish signing in, and reload that tab before checking again.'}; }
      const home = geminiHomeFor(tab.url);
      if (!home || !status?.signedIn || !status?.hasComposer) return {error: 'Finish signing in on the Gemini tab, then check again.'};
      await chrome.storage.local.set({geminiHome: home, browserSetup: true});
      return {ok: true};
    }
    let review = await current();
    if (message.type === 'CAPTURE_REVIEW') {
      if (review && busyPhases.includes(review.phase)) return {error: 'A review is already in progress. Finish it or stop it in the side panel first.'};
      if (!validContext(message.context)) return {error: 'Could not read this answer. Refresh ChatGPT and try again.'};
      review = {id: crypto.randomUUID(), phase: 'preview', context: message.context,
        selected: suggestedHistory(message.context), sourceTabId: sender.tab.id, windowId: sender.tab.windowId, createdAt: Date.now()};
      await save(review);
      return {ok: true};
    }
    if (message.type === 'GET_REVIEW') {
      if (review?.phase === 'opening') { await inspectAndStart(review); review = await current(); }
      return {review};
    }
    if (message.type === 'GEMINI_READY') {
      if (review?.geminiTabId === sender.tab.id) await inspectAndStart(review);
      return {ok: true};
    }
    if (!review || message.id !== review.id) return {error: 'This review has changed. Reopen the preview.'};
    if (message.type === 'SEND_REVIEW') {
      if (review.phase !== 'preview') return {error: 'This review has already been sent or cancelled.'};
      const prompt = buildReviewPrompt(review.context, message.selected);
      if (prompt.length > REVIEW_LIMIT) return {error: 'This prompt is too long. Deselect some earlier messages before sending.'};
      review = {...review, phase: 'opening', selected: message.selected, prompt, deadline: Date.now() + 180000};
      await save(review);
      try {
        const {geminiHome} = await chrome.storage.local.get(SETTINGS_DEFAULTS);
        const tab = await chrome.tabs.create({url: geminiHomeFor(geminiHome) || SETTINGS_DEFAULTS.geminiHome,
          active: true, windowId: review.windowId});
        review.geminiTabId = tab.id;
        await save(review);
        await inspectAndStart(review);
      } catch {
        review.phase = 'error'; review.error = 'Could not open a fresh Gemini tab. Capture the answer again and retry.';
        delete review.prompt; await save(review);
      }
      return {ok: true};
    }
    if (message.type === 'CONTINUE_REVIEW') {
      if (review.phase !== 'needs_attention') return {error: 'This review cannot be resumed.'};
      review.phase = 'opening'; review.deadline = Date.now() + 180000;
      await save(review); await inspectAndStart(review); return {ok: true};
    }
    if (message.type === 'SHOW_GEMINI') {
      if (!Number.isInteger(review.geminiTabId)) return {error: 'No Gemini tab has been opened for this review.'};
      await chrome.tabs.update(review.geminiTabId, {active: true}); return {ok: true};
    }
    if (message.type === 'CANCEL_REVIEW') {
      const sent = ['sending','waiting','done','error'].includes(review.phase);
      if (review.geminiTabId) chrome.tabs.sendMessage(review.geminiTabId, {type:'GEMINI_CANCEL', id:review.id}).catch(() => {});
      await save({id:review.id, phase:'cancelled', notice: sent
        ? 'Stopped waiting. A prompt already sent may remain in your Gemini history.' : 'Cancelled. No review will be submitted.'});
      return {ok:true};
    }
    if (gemini && sender.tab.id === review.geminiTabId && ['sending','waiting'].includes(review.phase)) {
      if (message.type === 'GEMINI_PROGRESS') {
        review.phase = 'waiting'; delete review.prompt;
      } else if (message.type === 'GEMINI_RESULT' && typeof message.raw === 'string' && message.raw.length <= 80000) {
        review.phase = 'done'; review.raw = message.raw; review.result = parseReview(message.raw); delete review.prompt;
      } else if (message.type === 'GEMINI_ERROR') {
        review.phase = 'error';
        review.error = typeof message.error === 'string' ? message.error.slice(0,500) : 'Gemini could not finish the review.';
        delete review.prompt;
      } else return {error:'Invalid result.'};
      await save(review); return {ok:true};
    }
    return {error:'This message does not belong to the active review.'};
  }).then(respond, () => respond({error:'The extension could not complete this action. Reload it and try again.'}));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  serial(async () => {
    const review = await current();
    if (review?.geminiTabId === tabId && busyPhases.includes(review.phase)) {
      review.phase = 'error'; review.error = 'The Gemini tab was closed. Capture the answer again to start a new review.';
      delete review.prompt; await save(review);
    }
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
