// Keep all DOM selectors here so ChatGPT markup changes have one fix location.
const CROSS_CHECK_SELECTORS = Object.freeze({
  // Current layout puts the role on a hidden heading. Target its reply wrapper,
  // not the heading itself. Keep support for the older message-role layout.
  assistantReply: '[data-content-search-unit-key]:has(> [data-conversation-role="assistant"]), [data-message-author-role="assistant"]',
  crossCheckButton: '[data-second-look-button]',
});
