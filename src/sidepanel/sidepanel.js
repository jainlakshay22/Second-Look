const fields = Object.fromEntries(Object.entries(PANEL_SELECTORS).map(([key, selector]) => [key,document.querySelector(selector)]));
let currentReview = null, selection = [], renderedKey = '', pending = false;
let activeRequest = null;
function status(text, error = false) {
  fields.status.textContent = text;
  fields.statusBox.dataset.state = error ? 'error' : currentReview?.phase || 'empty';
}
function updatePrompt() {
  try {
    const prompt = buildReviewPrompt(currentReview.context, selection, {mode:currentReview.mode || 'review',groundingEnabled:currentReview.groundingEnabled});
    fields.groundingNotice.hidden = currentReview.mode !== 'verify_claims' || !currentReview.groundingEnabled;
    fields.prompt.textContent = prompt;
    fields.size.textContent = `${prompt.length.toLocaleString()} / ${REVIEW_LIMIT.toLocaleString()} characters. Long captured messages are marked [Truncated].`;
    fields.send.disabled = pending || prompt.length > REVIEW_LIMIT;
  } catch { fields.send.disabled = true; }
}
function addText(parent, tag, text) { const node = document.createElement(tag); node.textContent = text; parent.append(node); return node; }
function renderResult(review) {
  fields.result.replaceChildren();
  const result = review.mode === 'verify_claims' ? review.result?.review : review.result;
  fields.result.dataset.verdict = result?.verdict || 'unformatted';
  if (!result) {
    addText(fields.result,'h2','Review format unavailable');
    addText(fields.result,'p','Gemini returned an unexpected format. You can read its original response below or review the context and try again.');
    addText(fields.result,'pre',review.raw || 'No readable response.');
    return;
  }
  if (Array.isArray(result.claims)) {
    fields.result.dataset.verdict = 'claims';
    renderClaimResult(fields.result, review.context.reply, result, review.result?.grounding);
    return;
  }
  const verdict = document.createElement('div'); verdict.className = 'verdict';
  addText(verdict,'p','VERDICT').className = 'eyebrow';
  addText(verdict,'h2',result.verdict.replaceAll('_',' '));
  addText(verdict,'p',result.summary).className = 'review-summary';
  fields.result.append(verdict);
  const source = document.createElement('details'); source.className = 'review-source';
  addText(source,'summary','Question reviewed');
  addText(source,'p',review.context.question); fields.result.append(source);
  const issues = document.createElement('section'); issues.className = 'review-section';
  addText(issues,'h3',`Issues · ${result.issues.length}`);
  if (!result.issues.length) addText(issues,'p','No issues reported.').className = 'empty-note';
  for (const item of result.issues) {
    const card = document.createElement('article'); card.className = 'issue-card'; card.dataset.severity = item.severity;
    addText(card,'span',`${item.severity} severity`).className = 'severity';
    addText(card,'p',item.description);
    addText(card,'p','Affected part').className = 'issue-location-label';
    addText(card,'blockquote',item.location);
    issues.append(card);
  }
  fields.result.append(issues);
  for (const [heading,items] of [['Missing points',result.missing_points],['Strengths',result.strengths]]) {
    const section = document.createElement('section'); section.className = 'review-section';
    addText(section,'h3',`${heading} · ${items.length}`);
    if (!items.length) addText(section,'p','None reported.').className = 'empty-note';
    else { const list = document.createElement('ul'); for (const item of items) addText(list,'li',item); section.append(list); }
    fields.result.append(section);
  }
}

function render(review) {
  if (activeRequest && (review?.id !== activeRequest.id || review.phase !== 'waiting')) activeRequest.controller.abort();
  const preserveSelection = currentReview?.id === review?.id && currentReview?.phase === 'preview' && review?.phase === 'preview';
  currentReview = review;
  const key = review ? `${review.id}:${review.phase}:${review.mode || 'review'}:${review.groundingEnabled}:${review.error || ''}` : '';
  if (key === renderedKey && renderedKey) return;
  renderedKey = key;
  fields.preview.hidden = review?.phase !== 'preview'; fields.result.hidden = review?.phase !== 'done';
  fields.progress.hidden = review?.phase !== 'waiting';
  fields.retry.hidden = !review || !['done','error'].includes(review.phase) || !review.context;
  fields.retry.textContent = review?.phase === 'error' ? 'Review context & retry' : 'Review again';
  fields.cancel.hidden = !review || ['cancelled','done','error'].includes(review.phase);
  fields.cancel.textContent = review?.phase === 'preview' ? 'Cancel' : 'Stop waiting';
  if (!review) { status('Choose Cross-check below an answer in ChatGPT.'); return; }
  if (review.phase === 'preview') {
    status('Nothing has been sent. Choose the context, then confirm.');
    if (!preserveSelection) selection = [...review.selected];
    fields.mode.value = review.mode || 'review';
    fields.question.textContent = review.context.question; fields.answer.textContent = review.context.reply;
    fields.history.replaceChildren();
    if (!review.context.history.length) addText(fields.history,'p','No earlier messages captured.');
    review.context.history.forEach((item,index) => {
      const container = document.createElement('div'); container.className = 'history-item';
      const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selection.includes(index);
      label.append(checkbox,document.createTextNode(`${item.role === 'user' ? 'You' : 'ChatGPT'} · earlier message ${index+1}`));
      checkbox.addEventListener('change',() => { selection = checkbox.checked ? [...selection,index] : selection.filter(value => value !== index); updatePrompt(); });
      container.append(label); addText(container,'pre',item.text); fields.history.append(container);
    });
    updatePrompt();
  } else if (review.phase === 'done') { status('Review received from the Gemini API.'); renderResult(review); }
  else if (review.phase === 'error') status(review.error,true);
  else if (review.phase === 'cancelled') status(review.notice);
  else status({waiting:'Gemini is reviewing your answer…'}[review.phase] || 'Working…');
}
async function refresh() {
  if (pending) return;
  try { const response = await chrome.runtime.sendMessage({type:'GET_REVIEW'}); if (response?.error) status(response.error,true); else render(response.review); }
  catch { status('Reload the extension and reopen this panel.',true); }
}
function runReview(id, prompt, approved = {}) {
  const job = {id, controller:new AbortController()};
  activeRequest = job;
  const options = {maxOutputTokens:8192,signal:job.controller.signal,headerTimeout:90000};
  const request = approved.mode === 'verify_claims'
    ? generateGeminiReview(approved.context,approved.selected,{
      ...options,mode:approved.mode,groundingEnabled:approved.groundingEnabled,approvedPrompt:prompt,
    }).then(result => ({result}))
    : generateGeminiText(prompt,{...options,schema:REVIEW_RESPONSE_SCHEMA}).then(raw => ({raw}));
  request.then(payload => chrome.runtime.sendMessage({type:'API_REVIEW_RESULT',id,...payload}), error => {
      if (job.controller.signal.aborted) return;
      return chrome.runtime.sendMessage({type:'API_REVIEW_ERROR',id,error:error instanceof GeminiError
        ? error.message : 'The review failed. Cross-check the answer again to retry.'});
    })
    .catch(() => status('Could not save the review. Reopen the panel before trying again.',true))
    .finally(() => { if (activeRequest === job) activeRequest = null; refresh(); });
}
async function action(type, extra={}) {
  if (pending || !currentReview) return;
  pending = true; fields.mode.disabled = true; fields.send.disabled = true; fields.retry.disabled = true; fields.cancel.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({type,id:currentReview.id,...extra});
    if (response?.error) { status(response.error,true); return; }
    if (type === 'SEND_REVIEW' && response?.ok && response.id && typeof response.prompt === 'string') runReview(response.id,response.prompt,response);
    if (type === 'CANCEL_REVIEW') activeRequest?.controller.abort();
    renderedKey = '';
  } catch { status('The extension stopped responding. Reopen this panel before trying again.',true); }
  finally { pending = false; fields.mode.disabled = false; fields.retry.disabled = false; fields.cancel.disabled = false; if (currentReview?.phase === 'preview') updatePrompt(); }
  await refresh();
}
fields.mode.addEventListener('change',()=>action('SET_REVIEW_MODE',{mode:fields.mode.value,selected:selection}));
fields.send.addEventListener('click',()=>action('SEND_REVIEW',{
  selected:selection,mode:currentReview?.mode || 'review',groundingEnabled:currentReview?.groundingEnabled,
}));
fields.cancel.addEventListener('click',()=>action('CANCEL_REVIEW'));
fields.retry.addEventListener('click',()=>action('EDIT_REVIEW'));
chrome.storage.onChanged.addListener((changes,area) => { if ((area === 'session' && changes.review) || (area === 'local' && changes.groundingEnabled)) refresh(); });
const poll = setInterval(refresh,2000);
window.addEventListener('pagehide',()=>{
  clearInterval(poll);
  if (activeRequest) {
    activeRequest.controller.abort();
    chrome.runtime.sendMessage({type:'CANCEL_REVIEW',id:activeRequest.id}).catch(()=>{});
  }
});
refresh();
