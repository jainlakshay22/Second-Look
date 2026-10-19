console.log("extension loaded");

// Only the latest capture is retained, in this extension's isolated script memory.
// No storage, page events, or network requests are used for the capture.
let lastCapturedContext = null;

// Query each time: ChatGPT can add or replace messages without a page reload.
function findAssistantReplies() {
  return Array.from(
    document.querySelectorAll(CROSS_CHECK_SELECTORS.assistantReply)
  ).filter((reply) => {
    // A reply can match both layouts; keep only the outermost wrapper.
    return !reply.parentElement?.closest(CROSS_CHECK_SELECTORS.assistantReply);
  });
}

function injectCrossCheckButtons() {
  for (const reply of findAssistantReplies()) {
    let button = reply.querySelector(CROSS_CHECK_SELECTORS.crossCheckButton);

    // Check the button as well as the marker: a re-render may remove our button
    // while leaving the marked message element in place.
    if (reply.hasAttribute("data-second-look-processed") && button) {
      if (reply.lastElementChild !== button) reply.append(button);
      continue;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.textContent = "Cross-check";
      button.className = "second-look-cross-check";
      button.setAttribute("data-second-look-button", "");
      button.title = "Capture this reply and recent conversation locally";
      button.addEventListener("click", () => {
        lastCapturedContext = null;
        try {
          lastCapturedContext = captureContext(reply);
          button.textContent = "Captured locally";
          button.title = "Context captured locally. Nothing has been sent.";
          // Log counts only; inspect lastCapturedContext explicitly in the
          // extension's DevTools context when debugging the captured object.
          console.log("[Second Look] Context captured locally", {
            questionCharacters: lastCapturedContext.question.length,
            replyCharacters: lastCapturedContext.reply.length,
            historyMessages: lastCapturedContext.history.length,
          });
        } catch (error) {
          button.textContent = "Capture failed";
          button.title = error.message;
          console.warn("[Second Look] " + error.message);
        }
        setTimeout(() => { button.textContent = "Cross-check"; }, 2000);
      });
      reply.append(button);
    }

    reply.setAttribute("data-second-look-processed", "");
  }
}

let scanScheduled = false;
const replyObserver = new MutationObserver(() => {
  // Batch page updates so streaming replies trigger at most one scan per frame.
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    refreshCrossCheckButtons();
  });
});

function refreshCrossCheckButtons() {
  // Our own button insertions must not trigger another observer scan.
  replyObserver.disconnect();
  try {
    injectCrossCheckButtons();
  } finally {
    replyObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-message-author-role",
        "data-conversation-role",
        "data-content-search-unit-key",
      ],
    });
  }
}

refreshCrossCheckButtons();
console.log("[Second Look] Assistant replies found:", findAssistantReplies().length);
