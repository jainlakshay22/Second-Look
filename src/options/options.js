const fields = Object.fromEntries(Object.entries(SETTINGS_SELECTORS).map(([name,selector]) => [name,document.querySelector(selector)]));
function setStatus(text,error=false) { fields.status.textContent=text; fields.status.dataset.state=error?'error':'success'; }
async function loadSettings() {
  try {
    await restrictSettingsStorage();
    const stored = await chrome.storage.local.get({...SETTINGS_DEFAULTS,browserSetup:false,apiKey:''});
    fields.historyCount.value=isValidHistoryCount(stored.historyCount)?stored.historyCount:4;
    fields.removeKey.hidden=!stored.apiKey;
    fields.accountStatus.textContent=stored.browserSetup?'Setup saved. Gemini sign-in is checked each time a review opens.':'Your Google login stays in Gemini.';
    fields.fieldset.disabled=false;
    setStatus('Ready. Open Gemini to set up your account.');
  } catch { setStatus('Could not load settings. Reload this page.',true); }
}
fields.form.addEventListener('submit',async event => {
  event.preventDefault(); if(!fields.form.reportValidity())return;
  const historyCount=Number(fields.historyCount.value);
  if(!isValidHistoryCount(historyCount)) {setStatus('Choose a count from 0 to 20.',true);return;}
  try {await chrome.storage.local.set({historyCount});setStatus('Settings saved.');}
  catch {setStatus('Could not save settings. Try again.',true);}
});
async function send(type) {
  fields.fieldset.disabled=true;
  try {
    const response=await chrome.runtime.sendMessage({type});
    if(response?.error) {setStatus(response.error,true);return;}
    if(type==='CHECK_GEMINI_SETUP') {
      fields.accountStatus.textContent='Gemini is signed in and ready in this Chrome profile.';
      setStatus('Connected. Return to ChatGPT and click Cross-check.');
    } else setStatus('Finish signing in on Gemini, then return here and check the connection.');
  } catch {setStatus('Could not reach the extension. Reload it and try again.',true);}
  finally {fields.fieldset.disabled=false;}
}
fields.openGemini.addEventListener('click',()=>send('OPEN_GEMINI_SETUP'));
fields.checkGemini.addEventListener('click',()=>send('CHECK_GEMINI_SETUP'));
fields.removeKey.addEventListener('click',async()=>{
  try {await chrome.storage.local.remove('apiKey');fields.removeKey.hidden=true;setStatus('The unused API key was removed.');}
  catch {setStatus('Could not remove the saved key. Try again.',true);}
});
loadSettings();
