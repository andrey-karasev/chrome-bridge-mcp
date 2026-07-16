#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { WebSocketServer } from "ws";

const WS_PORT = parseInt(process.env.CHROME_BRIDGE_PORT || "9229", 10);

// ─── Display Enumeration ─────────────────────────────────────

let _displayCache = null;
let _displayCacheTime = 0;
const DISPLAY_CACHE_TTL = 2000;

function getDisplaysSync() {
  const now = Date.now();
  if (_displayCache && now - _displayCacheTime < DISPLAY_CACHE_TTL) return _displayCache;

  const p = platform();
  let displays;

  if (p === "darwin") {
    const swiftScript = [
      "import CoreGraphics",
      "import Foundation",
      "var ids = [CGDirectDisplayID](repeating: 0, count: 16)",
      "var count: UInt32 = 0",
      "CGGetActiveDisplayList(16, &ids, &count)",
      "for i in 0..<Int(count) {",
      "  let id = ids[i]",
      "  let b = CGDisplayBounds(id)",
      '  print("\\(id),\\(Int(b.origin.x)),\\(Int(b.origin.y)),\\(Int(b.size.width)),\\(Int(b.size.height)),\\(CGDisplayIsMain(id) != 0 ? 1 : 0)")',
      "}",
    ].join("\n");
    const out = execSync("swift -", { input: swiftScript, encoding: "utf8", timeout: 10000 });
    displays = out.trim().split("\n").filter(Boolean).map((line, index) => {
      const [id, x, y, width, height, primary] = line.split(",").map(Number);
      return { index, id, x, y, width, height, primary: primary === 1 };
    });
  } else if (p === "linux") {
    const out = execSync("xrandr --query", { encoding: "utf8", timeout: 5000 });
    displays = [];
    let index = 0;
    for (const line of out.split("\n")) {
      const m = line.match(/^(\S+) connected(?: primary)? (\d+)x(\d+)\+(\d+)\+(\d+)/);
      if (m) {
        displays.push({
          index: index++, name: m[1],
          x: parseInt(m[4]), y: parseInt(m[5]),
          width: parseInt(m[2]), height: parseInt(m[3]),
          primary: line.includes(" primary "),
        });
      }
    }
  } else if (p === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $i=0; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { Write-Output "$i,$($_.Bounds.X),$($_.Bounds.Y),$($_.Bounds.Width),$($_.Bounds.Height),$($_.Primary)"; $i++ }`;
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf8", timeout: 5000 });
    displays = out.trim().split("\n").filter(Boolean).map(line => {
      const [index, x, y, width, height, primary] = line.split(",");
      return { index: parseInt(index), x: parseInt(x), y: parseInt(y), width: parseInt(width), height: parseInt(height), primary: primary.trim() === "True" };
    });
  } else {
    displays = [];
  }

  _displayCache = displays;
  _displayCacheTime = now;
  return displays;
}

// ─── WebSocket Bridge ────────────────────────────────────────

let chromeSocket = null;
let pendingRequests = new Map();
let requestId = 0;

const wss = new WebSocketServer({ port: WS_PORT });

wss.on("connection", (ws) => {
  process.stderr.write(`[chrome-bridge] Extension connected\n`);
  chromeSocket = ws;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
    } catch (err) {
      process.stderr.write(`[chrome-bridge] Parse error: ${err.message}\n`);
    }
  });

  ws.on("close", () => {
    process.stderr.write(`[chrome-bridge] Extension disconnected\n`);
    chromeSocket = null;
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error("Extension disconnected"));
    }
    pendingRequests.clear();
  });
});

function sendToExtension(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!chromeSocket || chromeSocket.readyState !== 1) {
      return reject(new Error("Chrome extension not connected. Make sure the extension is installed and active."));
    }

    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });

    chromeSocket.send(JSON.stringify({ id, method, params }));
  });
}

// ─── MCP Server ──────────────────────────────────────────────

const server = new McpServer({
  name: "chrome-bridge",
  version: "1.0.0",
});

server.tool(
  "browser_navigate",
  "Navigate the active tab to a URL",
  { url: z.string().describe("The URL to navigate to") },
  async ({ url }) => {
    const result = await sendToExtension("navigate", { url });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_read_page",
  "Read the text content and structure of the current page. Returns a simplified DOM representation.",
  {
    maxLength: z.number().optional().describe("Max characters to return (default 50000)"),
  },
  async ({ maxLength }) => {
    const result = await sendToExtension("readPage", { maxLength: maxLength || 50000 });
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "browser_read_selector",
  "Read the text content of elements matching a CSS selector",
  {
    selector: z.string().describe("CSS selector to query"),
    property: z.string().optional().describe("Property to read (default: textContent). Options: textContent, innerHTML, outerHTML, value"),
  },
  async ({ selector, property }) => {
    const result = await sendToExtension("readSelector", { selector, property: property || "textContent" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_click",
  "Click an element matching a CSS selector",
  {
    selector: z.string().describe("CSS selector of the element to click"),
    index: z.number().optional().describe("If multiple elements match, click the nth one (0-based, default 0)"),
  },
  async ({ selector, index }) => {
    const result = await sendToExtension("click", { selector, index: index || 0 });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_type",
  "Type text into an input element matching a CSS selector",
  {
    selector: z.string().describe("CSS selector of the input element"),
    text: z.string().describe("Text to type"),
    clear: z.boolean().optional().describe("Clear the field before typing (default true)"),
  },
  async ({ selector, text, clear }) => {
    const result = await sendToExtension("type", { selector, text, clear: clear !== false });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_screenshot",
  "Take a screenshot of the visible area of the active tab",
  {
    savePath: z.string().optional().describe("Optional file path to save the screenshot PNG to disk"),
  },
  async ({ savePath }) => {
    const result = await sendToExtension("screenshot", {});
    if (savePath) {
      writeFileSync(savePath, Buffer.from(result.data, "base64"));
      return { content: [{ type: "text", text: `Screenshot saved to ${savePath}` }, { type: "image", data: result.data, mimeType: "image/png" }] };
    }
    return { content: [{ type: "image", data: result.data, mimeType: "image/png" }] };
  }
);

server.tool(
  "browser_evaluate",
  "Execute JavaScript in the context of the active tab's page. Supports `return` and `await`.",
  {
    code: z.string().describe("JavaScript code to execute. Use `return` for a value. `await` is supported."),
    timeoutMs: z.number().optional().describe("Timeout in milliseconds (default 25000). The call always resolves within this window."),
  },
  async ({ code, timeoutMs }) => {
    const ms = timeoutMs ?? 25000;
    const result = await sendToExtension("evaluate", { code, timeoutMs: ms }, ms + 5000);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_set_file_input",
  "Set files on a file input element using Chrome DevTools Protocol (bypasses the OS file picker)",
  {
    files: z.array(z.string()).describe("Absolute file paths to set on the input element"),
    selector: z.string().optional().describe("CSS selector for the file input (default: input[type='file'])"),
  },
  async ({ files, selector }) => {
    const result = await sendToExtension("setFileInputFiles", { files, selector });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_force_detach_debugger",
  "Force-detach any Chrome DevTools Protocol debugger session from the active tab. Use this to recover from a stuck debugger.",
  {
    tabId: z.number().optional().describe("Tab ID to detach from (default: active tab)"),
  },
  async ({ tabId }) => {
    const result = await sendToExtension("forceDetach", { tabId });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_list_tabs",
  "List all open browser tabs",
  {},
  async () => {
    const result = await sendToExtension("listTabs", {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "browser_switch_tab",
  "Switch to a specific browser tab by its ID",
  {
    tabId: z.number().describe("The tab ID to switch to (from browser_list_tabs)"),
  },
  async ({ tabId }) => {
    const result = await sendToExtension("switchTab", { tabId });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_new_tab",
  "Open a new browser tab with an optional URL",
  {
    url: z.string().optional().describe("The URL to open (default: new tab page)"),
  },
  async ({ url }) => {
    const result = await sendToExtension("newTab", { url });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_close_tab",
  "Close a browser tab by its ID (default: the active tab)",
  {
    tabId: z.number().optional().describe("The tab ID to close (from browser_list_tabs); default: active tab"),
  },
  async ({ tabId }) => {
    const result = await sendToExtension("closeTab", { tabId });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_press_key",
  "Dispatch a keyboard event on the active element or a specific selector",
  {
    key: z.string().describe("Key to press (e.g., 'Enter', 'Tab', 'Escape', 'a')"),
    selector: z.string().optional().describe("CSS selector to target (default: document.activeElement)"),
    modifiers: z.object({
      ctrl: z.boolean().optional(),
      shift: z.boolean().optional(),
      alt: z.boolean().optional(),
      meta: z.boolean().optional(),
    }).optional().describe("Modifier keys to hold"),
  },
  async ({ key, selector, modifiers }) => {
    const result = await sendToExtension("pressKey", { key, selector, modifiers });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "browser_wait_for",
  "Wait for an element matching a selector to appear in the DOM",
  {
    selector: z.string().describe("CSS selector to wait for"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 10000)"),
  },
  async ({ selector, timeout }) => {
    const result = await sendToExtension("waitFor", { selector, timeout: timeout || 10000 });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

// ─── System Utility ──────────────────────────────────────────

server.tool(
  "system_sleep",
  "Pause execution for the specified number of milliseconds",
  { ms: z.number().describe("Milliseconds to sleep") },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { content: [{ type: "text", text: JSON.stringify({ slept: ms }) }] };
  }
);

// ─── Start ───────────────────────────────────────────────────

process.stderr.write(`[chrome-bridge] WebSocket server listening on ws://localhost:${WS_PORT}\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
