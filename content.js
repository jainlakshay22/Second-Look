console.log("extension loaded");

// Query each time: ChatGPT can add or replace messages without a page reload.
function findAssistantReplies() {
  return Array.from(
    document.querySelectorAll(CROSS_CHECK_SELECTORS.assistantReply)
  );
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
      button.title = "Cross-check this reply (review coming soon)";
      button.addEventListener("click", () => {
        // Context capture is the next step; no conversation text is logged.
        console.log("[Second Look] Cross-check clicked. Review coming soon.");
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
      attributeFilter: ["data-message-author-role"],
    });
  }
}

refreshCrossCheckButtons();
console.log("[Second Look] Assistant replies found:", findAssistantReplies().length);
