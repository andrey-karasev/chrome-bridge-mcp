// Check connection status by pinging the background worker
async function checkStatus() {
  const dot = document.getElementById("dot");
  const text = document.getElementById("status-text");

  try {
    const response = await chrome.runtime.sendMessage({ type: "status" });
    if (response?.connected) {
      dot.className = "dot connected";
      text.textContent = "Connected to MCP server";
    } else {
      dot.className = "dot disconnected";
      text.textContent = "Disconnected — is the server running?";
    }
  } catch {
    dot.className = "dot disconnected";
    text.textContent = "Extension error";
  }
}

checkStatus();
setInterval(checkStatus, 2000);
