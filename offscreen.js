// MV3 service workers have no Clipboard API; the offscreen document does.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "read-clipboard") return;
  (async () => {
    try {
      sendResponse({ ok: true, text: await navigator.clipboard.readText() });
    } catch (error) {
      // Older Chrome versions may still support the extension's paste command.
      const box = document.getElementById("clipboard-box");
      box.value = "";
      box.focus();
      try {
        if (!document.execCommand("paste")) throw error;
        sendResponse({ ok: true, text: box.value });
      } catch (fallbackError) {
        sendResponse({ ok: false, error: String(fallbackError) });
      }
    }
  })();
  return true;
});
