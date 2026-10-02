
// Toolbar click uses Chrome's trusted input pipeline to paste without a popup.
// Native paste does not read the clipboard or move focus in the page.
// Right-click the toolbar icon for copy through the same input pipeline.
// No extension items are added to page context menus.

chrome.action.onClicked.addListener(async tab => {
  if (!tab?.id) return;
  try {
    await perform(tab.id, "v");
    await flashBadge(tab.id, true);
  } catch (e) {
    console.error("mouse-copy-paste:", e);
    await flashBadge(tab.id, false).catch(console.error);
  }
});

// A later click owns the badge timeout; an older timeout must not clear it.
const badgeTimers = new Map();
async function flashBadge(tabId, ok) {
  const prior = badgeTimers.get(tabId);
  if (prior) clearTimeout(prior.timer);
  const token = Symbol();
  const state = { token, timer: null };
  badgeTimers.set(tabId, state);
  await chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? "#188038" : "#d93025" });
  await chrome.action.setBadgeText({ tabId, text: ok ? "✓" : "✗" });
  state.timer = setTimeout(() => {
    if (badgeTimers.get(tabId) !== state) return;
    badgeTimers.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }, 1000);
}

chrome.runtime.onInstalled.addListener(() => {
  // Remove the old selection/editable menu items when installing or reloading.
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.error("mouse-copy-paste:", chrome.runtime.lastError.message);
      return;
    }
    chrome.contextMenus.create({
      id: "toolbar-copy", title: "העתק", contexts: ["action"]
    }, () => {
      if (chrome.runtime.lastError) {
        console.error("mouse-copy-paste:", chrome.runtime.lastError.message);
      }
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "toolbar-copy" || !tab?.id) return;
  try {
    await perform(tab.id, "c");
    await flashBadge(tab.id, true);
  } catch (e) {
    console.error("mouse-copy-paste:", e);
    await flashBadge(tab.id, false).catch(console.error);
  }
});

// Serialize per tab. A second click while attached must not detach the first.
const pending = new Map();
function perform(tabId, letter) {
  const previous = pending.get(tabId) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => nativeOrFallback(tabId, letter));
  pending.set(tabId, task);
  task.finally(() => { if (pending.get(tabId) === task) pending.delete(tabId); }).catch(() => {});
  return task;
}

async function nativeOrFallback(tabId, letter) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (attachError) {
    // Only an attach failure is safe to retry by another method. Once a key
    // reaches Chrome, retrying could paste/copy twice.
    try { return await legacyFallback(tabId, letter); }
    catch (fallbackError) {
      throw new Error(`Debugger attach failed: ${attachError}; fallback failed: ${fallbackError}`);
    }
  }
  try {
    const send = (type, key, code, vk, modifiers) => chrome.debugger.sendCommand(
      target, "Input.dispatchKeyEvent", {
        type, key, code, windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk, modifiers
      });
    // modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
    await send("rawKeyDown", "Control", "ControlLeft", 17, 2);
    try {
      await send("keyDown", letter, `Key${letter.toUpperCase()}`,
        letter.toUpperCase().charCodeAt(0), 2);
      await send("keyUp", letter, `Key${letter.toUpperCase()}`,
        letter.toUpperCase().charCodeAt(0), 2);
    } finally {
      await send("keyUp", "Control", "ControlLeft", 17, 0).catch(console.error);
    }
  } finally {
    await chrome.debugger.detach(target).catch(console.error);
  }
}

async function legacyFallback(tabId, letter) {
  if (letter === "v") {
    const text = await readClipboardText();
    return executePaste({ tabId }, text);
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: () => document.execCommand("copy")
  });
  if (!results[0]?.result) throw new Error("Copy was not accepted");
}

async function executePaste(target, text) {
  const results = await chrome.scripting.executeScript({
    target, world: "MAIN", func: pasteText, args: [text]
  });
  if (!results.length || !results[0].result?.ok) {
    throw new Error(results[0]?.result?.error || "No text was inserted");
  }
}

function pasteText(text) {
  if (typeof text !== "string" || !text.length) {
    return { ok: false, error: "Clipboard is empty" };
  }
  const el = document.activeElement;
  const sheets = location.hostname === "docs.google.com" &&
    location.pathname.startsWith("/spreadsheets/");
  const gridInput = sheets ? document.querySelector(".cell-input") : null;
  const editor = el?.closest?.('[contenteditable="true"]');
  const isRegularField = el && (el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && /^(text|search|url|tel|password|email|number)$/.test(el.type)));
  // Only use the grid path if the selected element is the Sheets grid proxy,
  // not a formula bar, a dialog, or a regular editable control.
  const isGridTarget = sheets && gridInput &&
    (el === gridInput || el === document.body || el === document.documentElement ||
      !el || (!editor && !isRegularField));
  if (isGridTarget) {
    // Inserting TSV as text in one cell is not a multi-cell paste. Refuse it
    // rather than claim success or silently corrupt a table.
    if (/[\r\n\t]/.test(text)) {
      return { ok: false, error: "Multi-cell paste requires Ctrl+V in Sheets" };
    }
    const field = gridInput;
    if (!field.isConnected || !(field instanceof HTMLElement)) {
      return { ok: false, error: "Sheets grid editor is unavailable" };
    }
    field.focus();
    if (document.activeElement !== field) {
      return { ok: false, error: "Could not focus Sheets grid editor" };
    }
    const isTextControl = field.tagName === "TEXTAREA" || field.tagName === "INPUT";
    const before = isTextControl ? field.value : field.textContent;
    // A selected grid cell should be replaced, not have text appended to its
    // existing value. A real editor with a caret keeps normal insertion below.
    try {
      if (isTextControl) field.select();
      else if (field.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(field);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else return { ok: false, error: "Sheets grid editor is not editable" };
      const inserted = document.execCommand("insertText", false, text);
      let after = isTextControl ? field.value : field.textContent;
      if ((!inserted || !after.includes(text)) && isTextControl) {
        // Some browsers do not support execCommand on text controls.
        field.setRangeText(text, 0, field.value.length, "end");
        field.dispatchEvent(new InputEvent("input", { bubbles: true,
          inputType: "insertText", data: text }));
        after = field.value;
      }
      if (!after.includes(text) || after === before && before !== text) {
        return { ok: false, error: "Sheets editor did not accept text" };
      }
      // Sheets listens for Enter to commit an edited cell. These events are
      // synthetic; success below means editor insertion, not a verified save.
      field.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
      field.dispatchEvent(new KeyboardEvent("keyup", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true
      }));
      field.blur();
      return { ok: true, inserted: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  if (isRegularField) {
    try {
      const before = el.value;
      const start = el.selectionStart ?? before.length;
      const end = el.selectionEnd ?? before.length;
      el.setRangeText(text, start, end, "end");
      el.dispatchEvent(new InputEvent("input", { bubbles: true,
        inputType: "insertText", data: text }));
      return { ok: el.value === before.slice(0, start) + text + before.slice(end) };
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  if (editor) {
    const before = editor.textContent;
    const inserted = document.execCommand("insertText", false, text);
    return { ok: !!inserted && editor.textContent !== before &&
      editor.textContent.includes(text) };
  }
  return { ok: false, error: "No editable field is focused" };
}

let creatingOffscreen;
async function readClipboardText() {
  const url = chrome.runtime.getURL("offscreen.html");
  if (!creatingOffscreen) {
    creatingOffscreen = (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url]
      });
      if (contexts.length) return;
      await chrome.offscreen.createDocument({
        url: "offscreen.html", reasons: ["CLIPBOARD"],
        justification: "קריאת תוכן הלוח כדי להדביק בעמוד"
      });
    })().finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
  const reply = await chrome.runtime.sendMessage({ type: "read-clipboard" });
  if (!reply?.ok) throw new Error(reply?.error || "Clipboard read failed");
  return reply.text;
}

