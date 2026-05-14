# Chrome Bridge MCP

An MCP (Model Context Protocol) server + Chrome extension that lets AI assistants interact with your **real browser** — with your sessions, cookies, and logins intact. No headless browsers, no separate profiles.

## Why?

Existing browser automation (Playwright, Puppeteer, Selenium) launches isolated browser instances. Chrome Bridge connects to your actual Chrome window, so AI can:

- Navigate pages you're already logged into
- Interact with internal tools behind SSO
- See your extensions, bookmarks, and state
- Take screenshots of what you actually see

## Architecture

```
┌──────────────┐      stdio/MCP       ┌──────────────┐     WebSocket      ┌──────────────────┐
│  AI Client   │ ◄──────────────────► │  MCP Server  │ ◄────────────────► │ Chrome Extension │
│ (Claude Code │                      │  (Node.js)   │    localhost:9229   │  (Manifest V3)   │
│  / ChatGPT)  │                      └──────────────┘                    └──────────────────┘
└──────────────┘
```

## Prerequisites

- **Node.js** 18+ (for the MCP server)
- **Google Chrome** (or Chromium-based browser)
- An MCP-compatible AI client (Claude Code, Claude Desktop, ChatGPT Desktop, etc.)

## Installation

### 1. Clone and install dependencies

```bash
git clone https://github.com/andrey-karasev/chrome-bridge-mcp.git
cd chrome-bridge-mcp
npm install
```

### 2. Load the Chrome extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the `extension/` folder from this repository
5. The extension icon should appear in your toolbar with an orange "..." badge

### 3. Start the MCP server

```bash
npm start
```

The server starts a WebSocket listener on `localhost:9229`. Once the extension connects, the badge turns green ("ON").

You can customize the port via environment variable:

```bash
CHROME_BRIDGE_PORT=8888 npm start
```

## Configuration for AI Clients

### Claude Code (CLI)

Add to your project `.claude/settings.json` or global `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-bridge-mcp/mcp-server/index.mjs"],
      "env": {
        "CHROME_BRIDGE_PORT": "9229"
      }
    }
  }
}
```

**Example usage in Claude Code:**

```
You: Navigate to GitHub and show me my notifications
Claude: [calls browser_navigate with url "https://github.com/notifications"]
        [calls browser_read_page to get page content]
        Here are your notifications: ...

You: Take a screenshot of the current page
Claude: [calls browser_screenshot]
        Here's what the page looks like: [image]

You: Click the first unread notification
Claude: [calls browser_click with selector ".notification-unread a"]
        Done, I clicked on "Fix CI pipeline (#234)"
```

### Claude Desktop

Add to your Claude Desktop MCP configuration file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-bridge-mcp/mcp-server/index.mjs"],
      "env": {
        "CHROME_BRIDGE_PORT": "9229"
      }
    }
  }
}
```

### ChatGPT Desktop (with MCP support)

ChatGPT Desktop supports MCP servers via its settings. To configure:

1. Open **ChatGPT Desktop** → **Settings** → **Beta Features** → Enable **MCP Servers**
2. Go to **Settings** → **MCP Servers** → **Add Server**
3. Configure:
   - **Name:** `chrome-bridge`
   - **Command:** `node`
   - **Arguments:** `/absolute/path/to/chrome-bridge-mcp/mcp-server/index.mjs`

**Example usage in ChatGPT:**

```
You: Open my Jira board and summarize the current sprint
ChatGPT: [navigates to your Jira board using your existing session]
          [reads the page content]
          Here's your current sprint summary:
          - 5 In Progress, 3 In Review, 12 Done...

You: Fill in the "Description" field on this Jira ticket with a summary
ChatGPT: [uses browser_type to fill the field]
          Done — I've added the description.
```

### Other MCP Clients

Any MCP-compatible client can use Chrome Bridge. The server communicates over **stdio** using the standard MCP protocol. Configure your client to run:

```bash
node /absolute/path/to/chrome-bridge-mcp/mcp-server/index.mjs
```

Set the environment variable `CHROME_BRIDGE_PORT` if you need a custom WebSocket port (default: `9229`).

## Available Tools

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate the active tab to a URL |
| `browser_read_page` | Read simplified DOM structure of the current page |
| `browser_read_selector` | Read content of elements matching a CSS selector |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into input fields (supports React/Vue/Angular) |
| `browser_screenshot` | Capture a PNG screenshot of the visible viewport |
| `browser_evaluate` | Execute JavaScript in the page context |
| `browser_list_tabs` | List all open browser tabs |
| `browser_switch_tab` | Switch to a specific tab by ID |
| `browser_new_tab` | Open a new tab with an optional URL |
| `browser_press_key` | Dispatch keyboard events with modifier keys |
| `browser_wait_for` | Wait for an element to appear in the DOM |

## Usage Examples

### Reading a page

```
AI calls: browser_navigate({ url: "https://example.com" })
AI calls: browser_read_page({ maxLength: 50000 })
→ Returns simplified DOM tree with selectors, text content, and structure
```

### Filling a form

```
AI calls: browser_type({ selector: "#email", text: "user@example.com" })
AI calls: browser_type({ selector: "#password", text: "secret" })
AI calls: browser_click({ selector: "button[type=submit]" })
```

### Working with multiple tabs

```
AI calls: browser_list_tabs()
→ [{ id: 1, title: "Gmail", url: "..." }, { id: 2, title: "GitHub", url: "..." }]

AI calls: browser_switch_tab({ tabId: 2 })
AI calls: browser_read_page({})
```

### Taking screenshots

```
AI calls: browser_screenshot({ savePath: "/tmp/current-page.png" })
→ Screenshot saved to /tmp/current-page.png
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Extension badge shows "OFF" (red) | Make sure the MCP server is running (`npm start`) |
| Extension badge shows "..." (orange) | Server is starting up — wait a few seconds |
| "Chrome extension not connected" error | Open `chrome://extensions`, ensure the extension is enabled and reload it |
| Port conflict on 9229 | Change port: `CHROME_BRIDGE_PORT=8888 npm start` |
| Cannot access page content | Some pages (chrome://, extension pages) block content scripts |

## Security

- All communication is **localhost only** — no data leaves your machine
- The WebSocket connection is unencrypted (plain `ws://`) but only accepts local connections
- The extension requests broad permissions (`activeTab`, `tabs`, `scripting`, `debugger`) because it needs to interact with any page
- The `debugger` permission is used only for `browser_evaluate` (JavaScript execution)

## Development

```bash
# Start in watch mode (auto-restart on changes)
npm run dev

# The extension auto-reconnects when the server restarts
```

To modify the extension, edit files in `extension/` and click "Reload" in `chrome://extensions`.

## License

MIT

## Author

[Andrey Karasev](https://github.com/andrey-karasev)
