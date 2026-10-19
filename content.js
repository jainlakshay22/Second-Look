console.log("extension loaded");

// Return the assistant message elements currently in the DOM, in page order.
// Query again on each call because ChatGPT can add or replace messages.
function findAssistantReplies() {
  return Array.from(
    document.querySelectorAll(CROSS_CHECK_SELECTORS.assistantReply)
  );
}

// Only log the count, never the conversation text.
console.log("[Second Look] Assistant replies found:", findAssistantReplies().length);
