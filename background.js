// =============================================================================
// background.js — Service Worker (Manifest V3)
// =============================================================================
// In MV3, the background script runs as a service worker rather than a
// persistent background page. It handles lifecycle events and can relay
// messages between the popup (if any) and content scripts.
//
// Phase 1 role: minimal — just log install/startup and stay ready for
// future phases that will need message passing (e.g., triggering analysis).
// =============================================================================

// ── Lifecycle events ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[ChessReviewer] Extension installed/updated.", details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[ChessReviewer] Browser started — service worker active.");
});

// ── Message relay (placeholder for Phase 2+) ─────────────────────────────────
// Content scripts will send messages here. In later phases this will trigger
// engine analysis, store results, etc. For now, just echo them back.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[ChessReviewer:background] Message received:", message, "from tab:", sender.tab?.id);

  // Phase 1: acknowledge any message so content.js doesn't get a silent failure
  if (message.type === "GAME_DETECTED") {
    console.log("[ChessReviewer:background] Game detected event received. PGN length:", message.pgn?.length ?? 0);
    sendResponse({ status: "acknowledged", phase: 1 });
  }

  // Return true to keep the message channel open for async responses (future phases)
  return true;
});
