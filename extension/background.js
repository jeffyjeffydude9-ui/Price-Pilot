/* PricePilot service worker — light housekeeping for MV3. */

chrome.runtime.onInstalled.addListener(() => {
  // Seed default settings on first install.
  chrome.storage.sync.get(['settings'], (res) => {
    if (!res.settings) {
      chrome.storage.sync.set({
        settings: { targetMargin: 25, saved: [] }
      });
    }
  });
});
