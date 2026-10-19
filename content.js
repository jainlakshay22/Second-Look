console.log("extension loaded");

// Only the latest capture is retained, in this extension's isolated script memory.
// The worker keeps the preview in session storage until the user sends or cancels it.
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
      button.title = "Preview a Gemini review of this reply";
      button.addEventListener("click", async () => {
        lastCapturedContext = null;
        button.disabled = true;
        try {
          // Open before awaiting anything so Chrome retains the click gesture.
          const panel = await chrome.runtime.sendMessage({type: "OPEN_PREVIEW"});
          if (!panel?.ok) throw new Error("Could not open the preview. Reload the extension and refresh ChatGPT.");
          // Ask the worker only for non-secret capture settings.
          let settings;
          try {
            settings = await chrome.runtime.sendMessage({type: "GET_CAPTURE_SETTINGS"});
          } catch {
            throw new Error("Could not read settings. Reload the extension and refresh ChatGPT.");
          }
          if (!settings || settings.error || !Number.isInteger(settings.historyCount)
              || settings.historyCount < 0 || settings.historyCount > 20) {
            throw new Error("Could not read settings. Reload the extension and refresh ChatGPT.");
          }
          lastCapturedContext = captureContext(reply, settings.historyCount);
          const result = await chrome.runtime.sendMessage({type: "CAPTURE_REVIEW", context: lastCapturedContext});
          if (result?.error || !result?.ok) throw new Error(result?.error || "Could not prepare the review preview.");
          button.textContent = "Preview ready";
          button.title = "Choose the context and confirm Send in the side panel. Nothing has been sent to Gemini.";
        } catch (error) {
          button.textContent = "Capture failed";
          button.title = error.message;
          console.warn("[Second Look] " + error.message);
        } finally {
          button.disabled = false;
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
