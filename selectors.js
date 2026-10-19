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

// Selectors for the extension's settings page also stay in this file.
const SETTINGS_SELECTORS = Object.freeze({
  form: "#settings-form",
  fieldset: "#settings-fields",
  provider: "#provider",
  model: "#model",
  apiKey: "#api-key",
  historyCount: "#history-count",
  keyStatus: "#key-status",
  removeKey: "#remove-key",
  testConnection: "#test-connection",
  status: "#settings-status",
});

const PANEL_SELECTORS = Object.freeze({
  status:'#status', statusBox:'#status-box', progress:'#progress', retry:'#retry', preview:'#preview', question:'#question', answer:'#answer',
  history:'#history', prompt:'#prompt', size:'#size', send:'#send', cancel:'#cancel', result:'#result',
});
