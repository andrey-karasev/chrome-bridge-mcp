/**
 * Chrome Extension Background Service Worker
 * Connects to the MCP server's WebSocket and dispatches commands to content scripts.
 */

const WS_URL = "ws://localhost:9229";
const RECONNECT_DELAY = 3000;
const KEEPALIVE_INTERVAL = 0.4; // minutes (24 seconds — under the 30s service worker timeout)
const MESSAGE_ACTIVITY_BADGE_MS = 500;

let ws = null;
let connected = false;
let messageBadgeResetTimer = null;

// ─── Keep-Alive (prevents MV3 service worker termination) ───

chrome.alarms.create("keepalive", { periodInMinutes: KEEPALIVE_INTERVAL });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    } else if (!connected) {
      connect();
    }
  }
});

// ─── WebSocket Connection ────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    connected = true;
    console.log("[chrome-bridge] Connected to MCP server");
    updateBadge("●", "#4CAF50");
  };

  ws.onclose = () => {
    connected = false;
    if (messageBadgeResetTimer) {
      clearTimeout(messageBadgeResetTimer);
      messageBadgeResetTimer = null;
    }
    console.log("[chrome-bridge] Disconnected, reconnecting...");
    updateBadge("○", "#F44336");
    setTimeout(connect, RECONNECT_DELAY);
  };

  ws.onerror = (err) => {
    console.error("[chrome-bridge] WebSocket error:", err);
    ws.close();
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "pong") return;
      flashMessageActivityBadge();
      const { id, method, params } = msg;
      let result;

      try {
        result = await handleMethod(method, params);
        ws.send(JSON.stringify({ id, result }));
      } catch (err) {
        ws.send(JSON.stringify({ id, error: err.message }));
      }
    } catch (err) {
      console.error("[chrome-bridge] Message handling error:", err);
    }
  };
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function flashMessageActivityBadge() {
  updateBadge("●", "#2196F3");

  if (messageBadgeResetTimer) {
    clearTimeout(messageBadgeResetTimer);
  }

  messageBadgeResetTimer = setTimeout(() => {
    messageBadgeResetTimer = null;
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      updateBadge("ON", "#4CAF50");
    }
  }, MESSAGE_ACTIVITY_BADGE_MS);
}

// ─── Method Handlers ─────────────────────────────────────────

async function handleMethod(method, params) {
  switch (method) {
    case "navigate":
      return handleNavigate(params);
    case "readPage":
      return handleReadPage(params);
    case "readSelector":
      return handleReadSelector(params);
    case "click":
      return handleClick(params);
    case "type":
      return handleType(params);
    case "screenshot":
      return handleScreenshot(params);
    case "evaluate":
      return handleEvaluate(params);
    case "listTabs":
      return handleListTabs(params);
    case "switchTab":
      return handleSwitchTab(params);
    case "newTab":
      return handleNewTab(params);
    case "pressKey":
      return handlePressKey(params);
    case "waitFor":
      return handleWaitFor(params);
    case "setFileInputFiles":
      return handleSetFileInputFiles(params);
    case "forceDetach":
      return handleForceDetach(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab;
}

async function handleNavigate({ url }) {
  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { url });
  // Wait for navigation to complete
  return new Promise((resolve) => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ success: true, url });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout after 30s
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ success: true, url, note: "Navigation initiated (timeout waiting for complete)" });
    }, 30000);
  });
}

async function handleReadPage({ maxLength }) {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (maxLen) => {
      function buildTree(el, depth = 0) {
        if (depth > 10) return "";
        const tag = el.tagName?.toLowerCase();
        if (!tag) return "";
        if (["script", "style", "noscript", "svg", "path"].includes(tag)) return "";

        const parts = [];
        const role = el.getAttribute("role");
        const ariaLabel = el.getAttribute("aria-label");
        const id = el.id ? `#${el.id}` : "";
        const classes = el.className && typeof el.className === "string"
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "";

        let descriptor = tag + id + classes;
        if (role) descriptor += `[role=${role}]`;
        if (ariaLabel) descriptor += `[aria-label="${ariaLabel}"]`;
        if (tag === "a") descriptor += `[href="${el.getAttribute("href") || ""}"]`;
        if (tag === "input" || tag === "textarea" || tag === "select") {
          descriptor += `[type=${el.type || "text"}][name=${el.name || ""}][value="${(el.value || "").slice(0, 50)}"]`;
        }
        if (tag === "button" || tag === "a") {
          const text = el.textContent?.trim().slice(0, 80);
          if (text) descriptor += ` "${text}"`;
        }

        const indent = "  ".repeat(depth);

        if (el.children.length === 0) {
          const text = el.textContent?.trim();
          if (text && text.length > 0) {
            parts.push(`${indent}${descriptor}: ${text.slice(0, 200)}`);
          } else {
            parts.push(`${indent}${descriptor}`);
          }
        } else {
          parts.push(`${indent}${descriptor}`);
          for (const child of el.children) {
            const childResult = buildTree(child, depth + 1);
            if (childResult) parts.push(childResult);
          }
        }

        return parts.join("\n");
      }

      const tree = buildTree(document.body);
      return tree.slice(0, maxLen);
    },
    args: [maxLength || 50000],
  });

  return result.result;
}

async function handleReadSelector({ selector, property }) {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, prop) => {
      const elements = document.querySelectorAll(sel);
      if (elements.length === 0) return { found: 0, results: [] };
      return {
        found: elements.length,
        results: Array.from(elements).slice(0, 20).map((el, i) => ({
          index: i,
          value: prop === "value" ? el.value : el[prop] || el.getAttribute(prop) || "",
        })),
      };
    },
    args: [selector, property || "textContent"],
  });

  return result.result;
}

async function handleClick({ selector, index }) {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, idx) => {
      const elements = document.querySelectorAll(sel);
      if (elements.length === 0) return { success: false, error: `No elements found for: ${sel}` };
      const el = elements[idx || 0];
      if (!el) return { success: false, error: `Index ${idx} out of range (found ${elements.length})` };

      el.scrollIntoView({ block: "center" });
      el.focus();
      el.click();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return { success: true, clicked: el.tagName.toLowerCase(), text: el.textContent?.trim().slice(0, 100) };
    },
    args: [selector, index || 0],
  });

  return result.result;
}

async function handleType({ selector, text, clear }) {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, txt, shouldClear) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: `Element not found: ${sel}` };

      el.scrollIntoView({ block: "center" });
      el.focus();

      if (shouldClear) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // Set value and dispatch events to trigger React/Vue/Angular bindings
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, txt);
      } else {
        el.value = txt;
      }

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));

      return { success: true, selector: sel, typed: txt.slice(0, 50) };
    },
    args: [selector, text, clear !== false],
  });

  return result.result;
}

async function handleScreenshot() {
  const tab = await getActiveTab();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  // Strip the data:image/png;base64, prefix
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return { data: base64 };
}

async function handleEvaluate({ code, timeoutMs = 25000 }) {
  const tab = await getActiveTab();
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (codeStr, ms) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`evaluate timed out after ${ms}ms`)),
            ms
          );
          try {
            // AsyncFunction supports both synchronous `return` and `await`
            const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
            AsyncFn(codeStr)().then(
              (v) => { clearTimeout(timer); resolve(v); },
              (e) => { clearTimeout(timer); reject(e instanceof Error ? e.message : String(e)); }
            );
          } catch (e) {
            clearTimeout(timer);
            reject(e instanceof Error ? e.message : String(e));
          }
        });
      },
      args: [code, timeoutMs],
    });
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleSetFileInputFiles({ selector, files }) {
  const tab = await getActiveTab();
  const debugTarget = { tabId: tab.id };

  // Force-detach any stale session before attaching
  try { await chrome.debugger.detach(debugTarget); } catch (_) {}

  await chrome.debugger.attach(debugTarget, "1.3");
  try {
    const { root } = await chrome.debugger.sendCommand(debugTarget, "DOM.getDocument", {});
    const { nodeId } = await chrome.debugger.sendCommand(debugTarget, "DOM.querySelector", {
      nodeId: root.nodeId,
      selector: selector || "input[type='file']",
    });
    if (!nodeId) throw new Error(`No element found for selector: ${selector}`);
    await chrome.debugger.sendCommand(debugTarget, "DOM.setFileInputFiles", {
      files: files,
      nodeId: nodeId,
    });
    return { success: true };
  } finally {
    try { await chrome.debugger.detach(debugTarget); } catch (_) {}
  }
}

async function handleForceDetach({ tabId } = {}) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await getActiveTab();
  const debugTarget = { tabId: tab.id };
  try {
    await chrome.debugger.detach(debugTarget);
    return { success: true, tabId: tab.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function handleListTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
  }));
}

async function handleSwitchTab({ tabId }) {
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  return { success: true, tabId, title: tab.title, url: tab.url };
}

async function handleNewTab({ url }) {
  const tab = await chrome.tabs.create({ url: url || "chrome://newtab", active: true });
  return { success: true, tabId: tab.id, url: tab.pendingUrl || tab.url };
}

async function handlePressKey({ key, selector, modifiers }) {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (k, sel, mods) => {
      const target = sel ? document.querySelector(sel) : document.activeElement;
      if (!target) return { success: false, error: `Target not found: ${sel || "activeElement"}` };

      const eventInit = {
        key: k,
        code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
        bubbles: true,
        cancelable: true,
        ctrlKey: mods?.ctrl || false,
        shiftKey: mods?.shift || false,
        altKey: mods?.alt || false,
        metaKey: mods?.meta || false,
      };

      target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));

      return { success: true, key: k, target: target.tagName.toLowerCase() };
    },
    args: [key, selector || null, modifiers || {}],
  });

  return result.result;
}

async function handleWaitFor({ selector, timeout }) {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, ms) => {
      return new Promise((resolve) => {
        const existing = document.querySelector(sel);
        if (existing) {
          resolve({ found: true, waited: 0 });
          return;
        }

        const start = Date.now();
        const observer = new MutationObserver(() => {
          if (document.querySelector(sel)) {
            observer.disconnect();
            resolve({ found: true, waited: Date.now() - start });
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
          observer.disconnect();
          resolve({ found: false, error: `Timeout after ${ms}ms waiting for: ${sel}` });
        }, ms);
      });
    },
    args: [selector, timeout || 10000],
  });

  return result.result;
}

// ─── Message Handler (for popup) ─────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "status") {
    sendResponse({ connected });
    return true;
  }
});

// ─── Init ────────────────────────────────────────────────────

connect();
updateBadge("...", "#FF9800");
