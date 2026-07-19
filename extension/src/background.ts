/**
 * Chrome Extension Background Service Worker
 * Connects to the MCP server's WebSocket and dispatches commands to content scripts.
 */

const WS_URL = "ws://localhost:9229";
const RECONNECT_DELAY = 3000;
const KEEPALIVE_INTERVAL = 0.4; // minutes (24 seconds - under the 30s service worker timeout)
const MESSAGE_ACTIVITY_BADGE_MS = 500;

type JsonRpcMessage = {
  id?: number;
  type?: string;
  method?: string;
  params?: unknown;
};

type KeyModifiers = {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

let ws: WebSocket | null = null;
let connected = false;
let messageBadgeResetTimer: number | null = null;

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

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    connected = true;
    console.log("[chrome-bridge] Connected to MCP server");
    updateBadge(" ", "#4CAF50");
  };

  ws.onclose = () => {
    connected = false;
    if (messageBadgeResetTimer !== null) {
      clearTimeout(messageBadgeResetTimer);
      messageBadgeResetTimer = null;
    }
    console.log("[chrome-bridge] Disconnected, reconnecting...");
    updateBadge(" ", "#F44336");
    setTimeout(connect, RECONNECT_DELAY);
  };

  ws.onerror = (err) => {
    console.error("[chrome-bridge] WebSocket error:", err);
    ws?.close();
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data as string) as JsonRpcMessage;
      if (msg.type === "pong") {
        return;
      }

      flashMessageActivityBadge();
      const { id, method, params } = msg;
      let result: unknown;

      try {
        result = await handleMethod(method, params);
        ws?.send(JSON.stringify({ id, result }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ws?.send(JSON.stringify({ id, error: message }));
      }
    } catch (err) {
      console.error("[chrome-bridge] Message handling error:", err);
    }
  };
}

function updateBadge(text: string, color: string): void {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function flashMessageActivityBadge(): void {
  updateBadge(" ", "#2196F3");

  if (messageBadgeResetTimer !== null) {
    clearTimeout(messageBadgeResetTimer);
  }

  messageBadgeResetTimer = setTimeout(() => {
    messageBadgeResetTimer = null;
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      updateBadge(" ", "#4CAF50");
    }
  }, MESSAGE_ACTIVITY_BADGE_MS);
}

// ─── Method Handlers ─────────────────────────────────────────

async function handleMethod(method: string | undefined, params: unknown): Promise<unknown> {
  switch (method) {
    case "navigate":
      return handleNavigate(params as { url: string });
    case "readPage":
      return handleReadPage(params as { maxLength?: number });
    case "readSelector":
      return handleReadSelector(params as { selector: string; property?: string });
    case "click":
      return handleClick(params as { selector: string; index?: number });
    case "type":
      return handleType(params as { selector: string; text: string; clear?: boolean });
    case "screenshot":
      return handleScreenshot();
    case "evaluate":
      return handleEvaluate(params as { code: string; timeoutMs?: number });
    case "listTabs":
      return handleListTabs();
    case "switchTab":
      return handleSwitchTab(params as { tabId: number });
    case "newTab":
      return handleNewTab(params as { url?: string });
    case "closeTab":
      return handleCloseTab(params as { tabId?: number });
    case "pressKey":
      return handlePressKey(params as { key: string; selector?: string; modifiers?: KeyModifiers });
    case "waitFor":
      return handleWaitFor(params as { selector: string; timeout?: number });
    case "setFileInputFiles":
      return handleSetFileInputFiles(params as { selector?: string; files: string[] });
    case "forceDetach":
      return handleForceDetach((params as { tabId?: number }) || {});
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    throw new Error("No active tab found");
  }
  return tab;
}

async function handleNavigate({ url }: { url: string }): Promise<unknown> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;
  await chrome.tabs.update(tabId, { url });

  return new Promise((resolve) => {
    const listener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ success: true, url });
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ success: true, url, note: "Navigation initiated (timeout waiting for complete)" });
    }, 30000);
  });
}

async function handleReadPage({ maxLength }: { maxLength?: number }): Promise<string> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxLen: number) => {
      function buildTree(el: Element, depth = 0): string {
        if (depth > 10) {
          return "";
        }

        const tag = el.tagName?.toLowerCase();
        if (!tag) {
          return "";
        }

        if (["script", "style", "noscript", "svg", "path"].includes(tag)) {
          return "";
        }

        const parts: string[] = [];
        const role = el.getAttribute("role");
        const ariaLabel = el.getAttribute("aria-label");
        const id = el.id ? `#${el.id}` : "";
        const classes =
          el.className && typeof el.className === "string"
            ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
            : "";

        let descriptor = tag + id + classes;
        if (role) {
          descriptor += `[role=${role}]`;
        }
        if (ariaLabel) {
          descriptor += `[aria-label=\"${ariaLabel}\"]`;
        }
        if (tag === "a") {
          descriptor += `[href=\"${el.getAttribute("href") || ""}\"]`;
        }

        if (tag === "input" || tag === "textarea" || tag === "select") {
          const fieldEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          descriptor += `[type=${(fieldEl as HTMLInputElement).type || "text"}][name=${fieldEl.name || ""}][value=\"${(fieldEl.value || "").slice(0, 50)}\"]`;
        }

        if (tag === "button" || tag === "a") {
          const text = el.textContent?.trim().slice(0, 80);
          if (text) {
            descriptor += ` \"${text}\"`;
          }
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
          for (const child of Array.from(el.children)) {
            const childResult = buildTree(child, depth + 1);
            if (childResult) {
              parts.push(childResult);
            }
          }
        }

        return parts.join("\n");
      }

      const tree = buildTree(document.body);
      return tree.slice(0, maxLen);
    },
    args: [maxLength || 50000],
  });

  return (result?.result as string) || "";
}

async function handleReadSelector({ selector, property }: { selector: string; property?: string }): Promise<unknown> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel: string, prop: string) => {
      const elements = document.querySelectorAll(sel);
      if (elements.length === 0) {
        return { found: 0, results: [] };
      }

      return {
        found: elements.length,
        results: Array.from(elements)
          .slice(0, 20)
          .map((el, i) => {
            const valueSource = el as HTMLElement & { value?: string };
            const value =
              prop === "value"
                ? valueSource.value || ""
                : (valueSource as unknown as Record<string, string | undefined>)[prop] || el.getAttribute(prop) || "";

            return { index: i, value };
          }),
      };
    },
    args: [selector, property || "textContent"],
  });

  return result?.result;
}

async function handleClick({ selector, index }: { selector: string; index?: number }): Promise<unknown> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel: string, idx: number) => {
      const elements = document.querySelectorAll(sel);
      if (elements.length === 0) {
        return { success: false, error: `No elements found for: ${sel}` };
      }

      const el = elements[idx || 0] as HTMLElement | undefined;
      if (!el) {
        return { success: false, error: `Index ${idx} out of range (found ${elements.length})` };
      }

      el.scrollIntoView({ block: "center" });
      el.focus();
      el.click();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

      return { success: true, clicked: el.tagName.toLowerCase(), text: el.textContent?.trim().slice(0, 100) };
    },
    args: [selector, index || 0],
  });

  return result?.result;
}

async function handleType({ selector, text, clear }: { selector: string; text: string; clear?: boolean }): Promise<unknown> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel: string, txt: string, shouldClear: boolean) => {
      const el = document.querySelector(sel) as
        | (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
        | null;

      if (!el) {
        return { success: false, error: `Element not found: ${sel}` };
      }

      (el as HTMLElement).scrollIntoView({ block: "center" });
      (el as HTMLElement).focus();

      if (shouldClear) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // Set value and dispatch events to trigger React/Vue/Angular bindings
      const nativeInputValueSetter =
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

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

  return result?.result;
}

async function handleScreenshot(): Promise<{ data: string }> {
  const tab = await getActiveTab();
  const windowId = tab.windowId;
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return { data: base64 };
}

async function handleEvaluate({ code, timeoutMs = 25000 }: { code: string; timeoutMs?: number }): Promise<unknown> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (codeStr: string, ms: number) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`evaluate timed out after ${ms}ms`)), ms);
          try {
            const AsyncFn = Object.getPrototypeOf(async function () {}).constructor as (
              arg: string
            ) => () => Promise<unknown>;
            AsyncFn(codeStr)().then(
              (v: unknown) => {
                clearTimeout(timer);
                resolve(v);
              },
              (e: unknown) => {
                clearTimeout(timer);
                reject(e instanceof Error ? e.message : String(e));
              }
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
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

async function handleSetFileInputFiles({ selector, files }: { selector?: string; files: string[] }): Promise<unknown> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;
  const debugTarget = { tabId };

  try {
    await chrome.debugger.detach(debugTarget);
  } catch {
    // Ignore stale debugger detach failures.
  }

  await chrome.debugger.attach(debugTarget, "1.3");
  try {
    const documentResult = await chrome.debugger.sendCommand(debugTarget, "DOM.getDocument", {});
    const queryResult = await chrome.debugger.sendCommand(debugTarget, "DOM.querySelector", {
      nodeId: (documentResult as { root: { nodeId: number } }).root.nodeId,
      selector: selector || "input[type='file']",
    });

    const nodeId = (queryResult as { nodeId?: number }).nodeId;
    if (!nodeId) {
      throw new Error(`No element found for selector: ${selector}`);
    }

    await chrome.debugger.sendCommand(debugTarget, "DOM.setFileInputFiles", {
      files,
      nodeId,
    });

    return { success: true };
  } finally {
    try {
      await chrome.debugger.detach(debugTarget);
    } catch {
      // Ignore detach errors on cleanup.
    }
  }
}

async function handleForceDetach({ tabId }: { tabId?: number } = {}): Promise<unknown> {
  const tab = tabId ? await chrome.tabs.get(tabId) : await getActiveTab();
  const currentTabId = tab.id as number;
  const debugTarget = { tabId: currentTabId };

  try {
    await chrome.debugger.detach(debugTarget);
    return { success: true, tabId: currentTabId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, error: message };
  }
}

async function handleListTabs(): Promise<unknown> {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
  }));
}

async function handleSwitchTab({ tabId }: { tabId: number }): Promise<unknown> {
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return { success: true, tabId, title: tab.title, url: tab.url };
}

async function handleNewTab({ url }: { url?: string }): Promise<unknown> {
  const tab = await chrome.tabs.create({ url: url || "chrome://newtab", active: true });
  return { success: true, tabId: tab.id, url: tab.pendingUrl || tab.url };
}

async function handleCloseTab({ tabId }: { tabId?: number }): Promise<unknown> {
  const id = tabId ?? (await getActiveTab()).id;
  if (id === undefined) {
    throw new Error("No active tab found");
  }

  const tab = await chrome.tabs.get(id);
  await chrome.tabs.remove(id);
  return { success: true, tabId: id, title: tab.title, url: tab.url };
}

async function handlePressKey({
  key,
  selector,
  modifiers,
}: {
  key: string;
  selector?: string;
  modifiers?: KeyModifiers;
}): Promise<unknown> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (k: string, sel: string | null, mods: KeyModifiers) => {
      const target = sel ? document.querySelector(sel) : document.activeElement;
      if (!target) {
        return { success: false, error: `Target not found: ${sel || "activeElement"}` };
      }

      const eventInit: KeyboardEventInit = {
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

      return { success: true, key: k, target: (target as HTMLElement).tagName.toLowerCase() };
    },
    args: [key, selector || null, modifiers || {}],
  });

  return result?.result;
}

async function handleWaitFor({ selector, timeout }: { selector: string; timeout?: number }): Promise<unknown> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel: string, ms: number) => {
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

  return result?.result;
}

// ─── Message Handler (for popup) ─────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if ((msg as { type?: string }).type === "status") {
    sendResponse({ connected });
    return true;
  }

  return false;
});

// ─── Init ────────────────────────────────────────────────────

connect();
updateBadge(" ", "#FF9800");
