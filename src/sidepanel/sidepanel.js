const fields = Object.fromEntries(Object.entries(PANEL_SELECTORS).map(([key, selector]) => [key,document.querySelector(selector)]));
let currentReview = null, selection = [], renderedKey = '', pending = false;
let activeRequest = null;
function status(text, error = false) { fields.status.textContent = text; fields.status.dataset.error = error; }
function updatePrompt() {
  try {
    const prompt = buildReviewPrompt(currentReview.context, selection);
    fields.prompt.textContent = prompt;
    fields.size.textContent = `${prompt.length.toLocaleString()} / ${REVIEW_LIMIT.toLocaleString()} characters. Long captured messages are marked [Truncated].`;
    fields.send.disabled = pending || prompt.length > REVIEW_LIMIT;
  } catch { fields.send.disabled = true; }
}
function addText(parent, tag, text) { const node = document.createElement(tag); node.textContent = text; parent.append(node); return node; }
function renderResult(review) {
  fields.result.replaceChildren();
  if (!review.result) {
    addText(fields.result,'h2','Gemini’s response');
    addText(fields.result,'p','Gemini did not return the expected format. The original response is shown below.');
    addText(fields.result,'pre',review.raw || 'No readable response.'); return;
  }
  const result = review.result;
  addText(fields.result,'h2',result.verdict.replaceAll('_',' '));
  addText(fields.result,'p',result.summary);
  for (const [heading, items] of [['Issues', result.issues.map(item => `${item.severity.toUpperCase()}: ${item.description}\nWhere: ${item.location}`)],
    ['Missing points',result.missing_points],['Strengths',result.strengths]]) {
    addText(fields.result,'h3',heading);
    if (!items.length) addText(fields.result,'p','None reported.');
    else { const list = document.createElement('ul'); for (const item of items) addText(list,'li',item); fields.result.append(list); }
  }
}
function render(review) {
  if (activeRequest && (review?.id !== activeRequest.id || review.phase !== 'waiting')) activeRequest.controller.abort();
  currentReview = review;
  const key = review ? `${review.id}:${review.phase}:${review.error || ''}` : '';
  if (key === renderedKey && renderedKey) return;
  renderedKey = key;
  fields.preview.hidden = review?.phase !== 'preview'; fields.result.hidden = review?.phase !== 'done';
  fields.cancel.hidden = !review || ['cancelled','done','error'].includes(review.phase);
  fields.cancel.textContent = review?.phase === 'preview' ? 'Cancel' : 'Stop waiting';
  if (!review) { status('Choose Cross-check below an answer in ChatGPT.'); return; }
  if (review.phase === 'preview') {
    status('Nothing has been sent. Choose the context, then confirm.');
    selection = [...review.selected];
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
function runReview(id, prompt) {
  const job = {id, controller:new AbortController()};
  activeRequest = job;
  generateGeminiText(prompt,{maxOutputTokens:8192,schema:REVIEW_RESPONSE_SCHEMA,signal:job.controller.signal,headerTimeout:90000})
    .then(raw => chrome.runtime.sendMessage({type:'API_REVIEW_RESULT',id,raw}), error => {
      if (job.controller.signal.aborted) return;
      return chrome.runtime.sendMessage({type:'API_REVIEW_ERROR',id,error:error instanceof GeminiError
        ? error.message : 'The review failed. Cross-check the answer again to retry.'});
    })
    .catch(() => status('Could not save the review. Reopen the panel before trying again.',true))
    .finally(() => { if (activeRequest === job) activeRequest = null; refresh(); });
}
async function action(type, extra={}) {
  if (pending || !currentReview) return;
  pending = true; fields.send.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({type,id:currentReview.id,...extra});
    if (response?.error) { status(response.error,true); return; }
    if (type === 'SEND_REVIEW' && response?.ok && response.id && typeof response.prompt === 'string') runReview(response.id,response.prompt);
    if (type === 'CANCEL_REVIEW') activeRequest?.controller.abort();
    renderedKey = '';
  } catch { status('The extension stopped responding. Reopen this panel before trying again.',true); }
  finally { pending = false; if (currentReview.phase === 'preview') updatePrompt(); }
  await refresh();
}
fields.send.addEventListener('click',()=>action('SEND_REVIEW',{selected:selection}));
fields.cancel.addEventListener('click',()=>action('CANCEL_REVIEW'));
chrome.storage.onChanged.addListener((changes,area) => { if (area === 'session' && changes.review) refresh(); });
const poll = setInterval(refresh,2000);
window.addEventListener('pagehide',()=>{
  clearInterval(poll);
  if (activeRequest) {
    activeRequest.controller.abort();
    chrome.runtime.sendMessage({type:'CANCEL_REVIEW',id:activeRequest.id}).catch(()=>{});
  }
});
refresh();
