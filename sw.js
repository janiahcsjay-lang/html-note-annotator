chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["inject.js"] });
  } catch (e) {
    // 浏览器自身页面（chrome:// 等）不允许注入，忽略即可
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "hna-capture") {
    try {
      chrome.tabs.captureVisibleTab(sender.tab ? sender.tab.windowId : undefined, { format: "jpeg", quality: 92 }, (dataUrl) => {
        const err = chrome.runtime.lastError;
        sendResponse(err ? { ok: false, error: err.message } : { ok: true, dataUrl });
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true; // 异步 sendResponse
  }
  if (msg && msg.type === "hna-overview") {
    chrome.tabs.create({ url: chrome.runtime.getURL("overview.html") });
    sendResponse({ ok: true });
  }
});
