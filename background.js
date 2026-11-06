// Vivaldi implements chrome.sidePanel only partially, so every call may fail.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// YouTube refuses to play embeds without a Referer (Error 153), and pages of an extension do not send one.
// The rule applies only to player frames opened by this extension, and identifies the extension as the embedder.
const YOUTUBE_REFERER_RULE = {
  id: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [{ header: 'Referer', operation: 'set', value: `https://${chrome.runtime.id}.chromiumapp.org/` }],
  },
  condition: {
    requestDomains: ['youtube.com', 'youtube-nocookie.com'],
    resourceTypes: ['sub_frame'],
    initiatorDomains: [chrome.runtime.id],
  },
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [YOUTUBE_REFERER_RULE.id],
    addRules: [YOUTUBE_REFERER_RULE],
  }).catch((error) => console.error('YouTube referer rule:', error));
});

// Fires only when the toolbar click was not already handled by setPanelBehavior.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
  }
});
