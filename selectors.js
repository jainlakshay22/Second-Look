// Keep all DOM selectors here so ChatGPT markup changes have one fix location.
const CROSS_CHECK_SELECTORS = Object.freeze({
  // Current layout puts the role on a hidden heading. Target its reply wrapper,
  // not the heading itself. Keep support for the older message-role layout.
  assistantReply: '[data-content-search-unit-key]:has(> [data-conversation-role="assistant"]), [data-message-author-role="assistant"]',
  // In the current layout, user roles are encoded in the search-unit key.
  userMessage: '[data-content-search-unit-key$=":user"], [data-content-search-unit-key]:has(> [data-conversation-role="user"]), [data-message-author-role="user"]',
  conversationMessage: '[data-content-search-unit-key$=":user"], [data-content-search-unit-key]:has(> [data-conversation-role="user"], > [data-conversation-role="assistant"]), [data-message-author-role="user"], [data-message-author-role="assistant"]',
  roleHeading: ':scope > [data-conversation-role]',
  nonMessageContent: 'button, [role="button"], [role="toolbar"], [data-second-look-button], [data-conversation-role], .sr-only, [hidden], [aria-hidden="true"], script, style, svg',
  crossCheckButton: '[data-second-look-button]',
});

// Extension settings, panel, and Gemini website selectors stay here too.
const SETTINGS_SELECTORS = Object.freeze({
  form: '#settings-form', fieldset: '#settings-fields', historyCount: '#history-count',
  removeKey: '#remove-key', status: '#settings-status', accountStatus: '#account-status',
  openGemini: '#open-gemini-setup', checkGemini: '#check-gemini-setup',
});
const PANEL_SELECTORS = Object.freeze({
  status:'#status', preview:'#preview', question:'#question', answer:'#answer',
  history:'#history', prompt:'#prompt', size:'#size', send:'#send', cancel:'#cancel',
  continue:'#continue', openGemini:'#open-gemini', result:'#result',
});
const GEMINI_SELECTORS = Object.freeze({
  composer: '.ql-editor[contenteditable="true"][role="textbox"]',
  account: 'a[href*="accounts.google.com/SignOutOptions"]',
  send: 'button[aria-label="Send message"]',
  stop: 'button[aria-label="Stop response"]',
  response: 'model-response', user: 'user-query', body: '.markdown', code: 'pre code',
  copy: 'button[aria-label="Copy"]',
});
