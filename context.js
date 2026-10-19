const DEFAULT_HISTORY_COUNT = 4;
const MAX_MESSAGE_CHARACTERS = 8000;
const TRUNCATION_NOTICE = "\n[Truncated]";

function getMessageRole(message) {
  if (message.matches(CROSS_CHECK_SELECTORS.userMessage)) return "user";
  return message.querySelector(CROSS_CHECK_SELECTORS.roleHeading)
    ?.getAttribute("data-conversation-role")
    || message.getAttribute("data-message-author-role");
}

function findConversationMessages() {
  return Array.from(document.querySelectorAll(CROSS_CHECK_SELECTORS.conversationMessage))
    .filter((message) => {
      // ChatGPT may render hidden copies and nest old markup inside new wrappers.
      const style = getComputedStyle(message);
      return !message.parentElement?.closest(CROSS_CHECK_SELECTORS.conversationMessage)
        && message.getClientRects().length > 0
        && style.visibility !== "hidden"
        && style.visibility !== "collapse";
    });
}

function getMessageText(message) {
  // Read the original DOM without modifying it. Preserve paragraph/code breaks
  // while excluding UI controls, speaker headings, and hidden content.
  function read(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.matches(CROSS_CHECK_SELECTORS.nonMessageContent)) return "";
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden"
        || style.visibility === "collapse") return "";
    if (node.tagName === "BR") return "\n";
    const text = Array.from(node.childNodes, read).join("");
    if (!text.trim()) return text;
    if (node.tagName === "TD" || node.tagName === "TH") return text + "\t";
    if (["block", "flex", "grid", "list-item", "table-row", "flow-root"].includes(style.display)) {
      return "\n" + text + "\n";
    }
    return text;
  }
  return read(message).trim();
}

function truncateMessage(text) {
  if (text.length <= MAX_MESSAGE_CHARACTERS) return text;
  let prefix = text.slice(0, MAX_MESSAGE_CHARACTERS - TRUNCATION_NOTICE.length);
  // Avoid cutting an emoji's UTF-16 surrogate pair in half.
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + TRUNCATION_NOTICE;
}

function captureContext(reply, historyCount = DEFAULT_HISTORY_COUNT) {
  if (!Number.isSafeInteger(historyCount) || historyCount < 0) {
    throw new Error("The history count must be a non-negative whole number.");
  }
  const messages = findConversationMessages();
  const replyIndex = messages.indexOf(reply);
  if (replyIndex === -1 || getMessageRole(reply) !== "assistant") {
    throw new Error("This reply is no longer available. Refresh the chat and try again.");
  }
  let questionIndex = replyIndex - 1;
  while (questionIndex >= 0 && getMessageRole(messages[questionIndex]) !== "user") {
    questionIndex--;
  }
  if (questionIndex < 0) {
    throw new Error("The preceding question is not loaded. Scroll up to load it and try again.");
  }
  const question = getMessageText(messages[questionIndex]);
  const answer = getMessageText(reply);
  if (!question || !answer) {
    throw new Error("The question or reply has no readable text yet. Wait and try again.");
  }
  const previous = messages.slice(0, replyIndex)
    .filter((message, index) => index !== questionIndex);
  // slice(-0) returns the whole array, so explicitly handle zero history.
  const history = (historyCount === 0 ? [] : previous.slice(-historyCount))
    .map((message) => ({
      role: getMessageRole(message),
      text: truncateMessage(getMessageText(message)),
    }));
  return {
    question: truncateMessage(question),
    reply: truncateMessage(answer),
    history,
    source: "chatgpt.com",
    capturedAt: new Date().toISOString(),
  };
}
