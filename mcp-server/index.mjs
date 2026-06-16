#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { WebSocketServer } from "ws";
import {
  mouse, keyboard, screen, clipboard,
  Key, Button, FileType, Point, Region, Size,
  straightTo, sleep as nutSleep,
  getWindows, getActiveWindow,
} from "@nut-tree-fork/nut-js";

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
  "Execute JavaScript in the context of the active tab's page",
  {
    code: z.string().describe("JavaScript code to execute. Use `return` for a value."),
  },
  async ({ code }) => {
    const result = await sendToExtension("evaluate", { code });
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

// ─── nut-js Helpers ──────────────────────────────────────────

const KEY_NAMES = Object.keys(Key).filter((k) => isNaN(k)).join(", ");

function resolveKey(name) {
  if (!(name in Key)) throw new Error(`Unknown key: "${name}". Valid: ${KEY_NAMES}`);
  return Key[name];
}

function resolveButton(name) {
  const map = { LEFT: Button.LEFT, MIDDLE: Button.MIDDLE, RIGHT: Button.RIGHT };
  if (!(name in map)) throw new Error(`Unknown button: "${name}". Valid: LEFT, MIDDLE, RIGHT`);
  return map[name];
}

// ─── Mouse Tools ─────────────────────────────────────────────

server.tool(
  "mouse_move",
  "Move the mouse cursor to the specified screen coordinates",
  { x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate") },
  async ({ x, y }) => {
    await mouse.move(straightTo(new Point(x, y)));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, x, y }) }] };
  }
);

server.tool(
  "mouse_click",
  "Click a mouse button at the current or specified position",
  {
    button: z.enum(["LEFT", "MIDDLE", "RIGHT"]).optional().describe("Mouse button (default: LEFT)"),
    x: z.number().optional().describe("X coordinate to move to before clicking"),
    y: z.number().optional().describe("Y coordinate to move to before clicking"),
  },
  async ({ button, x, y }) => {
    if (x !== undefined && y !== undefined) await mouse.move(straightTo(new Point(x, y)));
    await mouse.click(resolveButton(button ?? "LEFT"));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, button: button ?? "LEFT", x, y }) }] };
  }
);

server.tool(
  "mouse_double_click",
  "Double-click a mouse button at the current or specified position",
  {
    button: z.enum(["LEFT", "MIDDLE", "RIGHT"]).optional().describe("Mouse button (default: LEFT)"),
    x: z.number().optional().describe("X coordinate to move to before clicking"),
    y: z.number().optional().describe("Y coordinate to move to before clicking"),
  },
  async ({ button, x, y }) => {
    if (x !== undefined && y !== undefined) await mouse.move(straightTo(new Point(x, y)));
    await mouse.doubleClick(resolveButton(button ?? "LEFT"));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, button: button ?? "LEFT", x, y }) }] };
  }
);

server.tool(
  "mouse_drag",
  "Press-hold the left button at the current position, drag to target coordinates, then release",
  { x: z.number().describe("Target X coordinate"), y: z.number().describe("Target Y coordinate") },
  async ({ x, y }) => {
    await mouse.drag(straightTo(new Point(x, y)));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, x, y }) }] };
  }
);

server.tool(
  "mouse_scroll_down",
  "Scroll the mouse wheel downward",
  { amount: z.number().describe("Number of scroll ticks") },
  async ({ amount }) => {
    await mouse.scrollDown(amount);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, direction: "down", amount }) }] };
  }
);

server.tool(
  "mouse_scroll_up",
  "Scroll the mouse wheel upward",
  { amount: z.number().describe("Number of scroll ticks") },
  async ({ amount }) => {
    await mouse.scrollUp(amount);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, direction: "up", amount }) }] };
  }
);

server.tool(
  "mouse_scroll_left",
  "Scroll the mouse wheel to the left",
  { amount: z.number().describe("Number of scroll ticks") },
  async ({ amount }) => {
    await mouse.scrollLeft(amount);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, direction: "left", amount }) }] };
  }
);

server.tool(
  "mouse_scroll_right",
  "Scroll the mouse wheel to the right",
  { amount: z.number().describe("Number of scroll ticks") },
  async ({ amount }) => {
    await mouse.scrollRight(amount);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, direction: "right", amount }) }] };
  }
);

server.tool(
  "mouse_get_position",
  "Get the current mouse cursor position",
  {},
  async () => {
    const pos = await mouse.getPosition();
    return { content: [{ type: "text", text: JSON.stringify({ x: pos.x, y: pos.y }) }] };
  }
);

server.tool(
  "mouse_set_position",
  "Teleport the mouse cursor to a position instantly (no animation)",
  { x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate") },
  async ({ x, y }) => {
    await mouse.setPosition(new Point(x, y));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, x, y }) }] };
  }
);

server.tool(
  "mouse_press_button",
  "Press and hold a mouse button without releasing it",
  { button: z.enum(["LEFT", "MIDDLE", "RIGHT"]).optional().describe("Button to press (default: LEFT)") },
  async ({ button }) => {
    await mouse.pressButton(resolveButton(button ?? "LEFT"));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, button: button ?? "LEFT" }) }] };
  }
);

server.tool(
  "mouse_release_button",
  "Release a previously pressed mouse button",
  { button: z.enum(["LEFT", "MIDDLE", "RIGHT"]).optional().describe("Button to release (default: LEFT)") },
  async ({ button }) => {
    await mouse.releaseButton(resolveButton(button ?? "LEFT"));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, button: button ?? "LEFT" }) }] };
  }
);

// ─── Keyboard Tools ──────────────────────────────────────────

server.tool(
  "keyboard_type",
  "Type a string of text using the keyboard",
  { text: z.string().describe("Text to type") },
  async ({ text }) => {
    await keyboard.type(text);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, typed: text }) }] };
  }
);

server.tool(
  "keyboard_press_key",
  `Press one or more keys simultaneously (supports key combos). Valid key names: ${KEY_NAMES}`,
  { keys: z.array(z.string()).describe("Key names to press simultaneously, e.g. [\"LeftControl\", \"C\"]") },
  async ({ keys }) => {
    await keyboard.pressKey(...keys.map(resolveKey));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, keys }) }] };
  }
);

server.tool(
  "keyboard_release_key",
  `Release one or more previously held keys. Valid key names: ${KEY_NAMES}`,
  { keys: z.array(z.string()).describe("Key names to release") },
  async ({ keys }) => {
    await keyboard.releaseKey(...keys.map(resolveKey));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, keys }) }] };
  }
);

// ─── Screen Tools ────────────────────────────────────────────

server.tool(
  "get_displays",
  "List all connected displays with their index, bounds (x, y, width, height in virtual screen coordinates), and which is primary. Pass the index to screen_capture or screen_size to target a specific display.",
  {},
  async () => {
    const displays = getDisplaysSync();
    return { content: [{ type: "text", text: JSON.stringify(displays, null, 2) }] };
  }
);

server.tool(
  "screen_size",
  "Get the screen width and height in pixels",
  {
    display: z.number().optional().describe("Display index from get_displays. If omitted, returns the primary display size."),
  },
  async ({ display }) => {
    if (display !== undefined) {
      const displays = getDisplaysSync();
      const d = displays[display];
      if (!d) throw new Error(`Display ${display} not found. Run get_displays to list available displays.`);
      return { content: [{ type: "text", text: JSON.stringify({ width: d.width, height: d.height, x: d.x, y: d.y, display: d.index }) }] };
    }
    const [width, height] = await Promise.all([screen.width(), screen.height()]);
    return { content: [{ type: "text", text: JSON.stringify({ width, height }) }] };
  }
);

server.tool(
  "screen_capture",
  "Capture the entire screen and save as a PNG file",
  {
    fileName: z.string().describe("File name without extension"),
    filePath: z.string().optional().describe("Directory path to save to (default: current working directory)"),
    display: z.number().optional().describe("Display index from get_displays. If omitted, captures the primary display."),
  },
  async ({ fileName, filePath, display }) => {
    if (display !== undefined) {
      const displays = getDisplaysSync();
      const d = displays[display];
      if (!d) throw new Error(`Display ${display} not found. Run get_displays to list available displays.`);
      await screen.captureRegion(fileName, new Region(d.x, d.y, d.width, d.height), FileType.PNG, filePath);
    } else {
      await screen.capture(fileName, FileType.PNG, filePath);
    }
    const saved = `${filePath ?? "."}/${fileName}${FileType.PNG}`;
    return { content: [{ type: "text", text: JSON.stringify({ success: true, saved }) }] };
  }
);

server.tool(
  "screen_capture_region",
  "Capture a rectangular region of the screen and save as a PNG file",
  {
    fileName: z.string().describe("File name without extension"),
    x: z.number().describe("Region left edge"),
    y: z.number().describe("Region top edge"),
    width: z.number().describe("Region width"),
    height: z.number().describe("Region height"),
    filePath: z.string().optional().describe("Directory path to save to (default: current working directory)"),
  },
  async ({ fileName, x, y, width, height, filePath }) => {
    await screen.captureRegion(fileName, new Region(x, y, width, height), FileType.PNG, filePath);
    const saved = `${filePath ?? "."}/${fileName}${FileType.PNG}`;
    return { content: [{ type: "text", text: JSON.stringify({ success: true, saved, x, y, width, height }) }] };
  }
);

server.tool(
  "screen_color_at",
  "Get the RGBA color of a pixel at the specified screen coordinates",
  { x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate") },
  async ({ x, y }) => {
    const color = await screen.colorAt(new Point(x, y));
    return { content: [{ type: "text", text: JSON.stringify({ x, y, r: color.R, g: color.G, b: color.B, a: color.A }) }] };
  }
);

server.tool(
  "screen_highlight",
  "Draw a highlight rectangle over a screen region (useful for debugging)",
  {
    x: z.number().describe("Region left edge"),
    y: z.number().describe("Region top edge"),
    width: z.number().describe("Region width"),
    height: z.number().describe("Region height"),
  },
  async ({ x, y, width, height }) => {
    await screen.highlight(new Region(x, y, width, height));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, x, y, width, height }) }] };
  }
);

// ─── Clipboard Tools ─────────────────────────────────────────

server.tool(
  "clipboard_get",
  "Get the current clipboard text content",
  {},
  async () => {
    const content = await clipboard.getContent();
    return { content: [{ type: "text", text: JSON.stringify({ content }) }] };
  }
);

server.tool(
  "clipboard_set",
  "Set the clipboard text content",
  { text: z.string().describe("Text to write to the clipboard") },
  async ({ text }) => {
    await clipboard.setContent(text);
    return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
  }
);

// ─── Window Tools ────────────────────────────────────────────

server.tool(
  "window_list",
  "List all open application windows with their titles and positions",
  {},
  async () => {
    const windows = await getWindows();
    const info = await Promise.all(
      windows.map(async (w) => {
        try {
          const [title, region] = await Promise.all([w.getTitle(), w.getRegion()]);
          return { title, x: region.left, y: region.top, width: region.width, height: region.height };
        } catch {
          return { title: "unknown" };
        }
      })
    );
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

server.tool(
  "window_get_active",
  "Get the currently focused window title and position",
  {},
  async () => {
    const win = await getActiveWindow();
    const [title, region] = await Promise.all([win.getTitle(), win.getRegion()]);
    return { content: [{ type: "text", text: JSON.stringify({ title, x: region.left, y: region.top, width: region.width, height: region.height }) }] };
  }
);

server.tool(
  "window_focus",
  "Bring a window to the foreground by matching its title (substring match)",
  { title: z.string().describe("Substring of the window title to search for") },
  async ({ title }) => {
    const windows = await getWindows();
    for (const w of windows) {
      const t = await w.getTitle();
      if (t.includes(title)) {
        await w.focus();
        return { content: [{ type: "text", text: JSON.stringify({ success: true, title: t }) }] };
      }
    }
    throw new Error(`No window found with title containing: "${title}"`);
  }
);

server.tool(
  "window_minimize",
  "Minimize a window by matching its title (substring match)",
  { title: z.string().describe("Substring of the window title to search for") },
  async ({ title }) => {
    const windows = await getWindows();
    for (const w of windows) {
      const t = await w.getTitle();
      if (t.includes(title)) {
        await w.minimize();
        return { content: [{ type: "text", text: JSON.stringify({ success: true, title: t }) }] };
      }
    }
    throw new Error(`No window found with title containing: "${title}"`);
  }
);

server.tool(
  "window_restore",
  "Restore a minimized window by matching its title (substring match)",
  { title: z.string().describe("Substring of the window title to search for") },
  async ({ title }) => {
    const windows = await getWindows();
    for (const w of windows) {
      const t = await w.getTitle();
      if (t.includes(title)) {
        await w.restore();
        return { content: [{ type: "text", text: JSON.stringify({ success: true, title: t }) }] };
      }
    }
    throw new Error(`No window found with title containing: "${title}"`);
  }
);

server.tool(
  "window_move",
  "Move a window to the specified screen coordinates by matching its title",
  {
    title: z.string().describe("Substring of the window title to search for"),
    x: z.number().describe("Target X coordinate"),
    y: z.number().describe("Target Y coordinate"),
  },
  async ({ title, x, y }) => {
    const windows = await getWindows();
    for (const w of windows) {
      const t = await w.getTitle();
      if (t.includes(title)) {
        await w.move(new Point(x, y));
        return { content: [{ type: "text", text: JSON.stringify({ success: true, title: t, x, y }) }] };
      }
    }
    throw new Error(`No window found with title containing: "${title}"`);
  }
);

server.tool(
  "window_resize",
  "Resize a window by matching its title",
  {
    title: z.string().describe("Substring of the window title to search for"),
    width: z.number().describe("New width in pixels"),
    height: z.number().describe("New height in pixels"),
  },
  async ({ title, width, height }) => {
    const windows = await getWindows();
    for (const w of windows) {
      const t = await w.getTitle();
      if (t.includes(title)) {
        await w.resize(new Size(width, height));
        return { content: [{ type: "text", text: JSON.stringify({ success: true, title: t, width, height }) }] };
      }
    }
    throw new Error(`No window found with title containing: "${title}"`);
  }
);

// ─── System Utility ──────────────────────────────────────────

server.tool(
  "system_sleep",
  "Pause execution for the specified number of milliseconds",
  { ms: z.number().describe("Milliseconds to sleep") },
  async ({ ms }) => {
    await nutSleep(ms);
    return { content: [{ type: "text", text: JSON.stringify({ slept: ms }) }] };
  }
);

// ─── Start ───────────────────────────────────────────────────

process.stderr.write(`[chrome-bridge] WebSocket server listening on ws://localhost:${WS_PORT}\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
