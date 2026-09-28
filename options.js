"use strict";

const form = document.getElementById("token-form");
const input = document.getElementById("token");
const statusLine = document.getElementById("status");
const clearButton = document.getElementById("clear");

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error?.message || "Extension request failed."));
        return;
      }
      resolve(response.result);
    });
  });
}

function showStatus(text, kind = "") {
  statusLine.textContent = text;
  statusLine.className = `status ${kind}`.trim();
}

async function refreshStatus() {
  const { configured, login } = await send({ type: "token-status" });
  clearButton.disabled = !configured;
  if (configured) showStatus(`Token saved for ${login || "an unknown user"}.`, "good");
  else showStatus("No token saved.");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus("Verifying with GitHub…");
  try {
    const { login } = await send({ type: "save-token", token: input.value });
    input.value = "";
    clearButton.disabled = false;
    showStatus(`Token saved for ${login}.`, "good");
  } catch (error) {
    showStatus(error.message, "error");
  }
});

clearButton.addEventListener("click", async () => {
  try {
    await send({ type: "clear-token" });
    await refreshStatus();
  } catch (error) {
    showStatus(error.message, "error");
  }
});

refreshStatus().catch((error) => showStatus(error.message, "error"));
