async function checkStatus(): Promise<void> {
  const dot = document.getElementById("dot");
  const text = document.getElementById("status-text");

  if (!dot || !text) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "status" }) as { connected?: boolean };
    if (response?.connected) {
      dot.className = "dot connected";
      text.textContent = "Connected to MCP server";
    } else {
      dot.className = "dot disconnected";
      text.textContent = "Disconnected - is the server running?";
    }
  } catch {
    dot.className = "dot disconnected";
    text.textContent = "Extension error";
  }
}

void checkStatus();
setInterval(() => {
  void checkStatus();
}, 2000);
