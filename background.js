// =============================================================================
// background.js — Service Worker (Manifest V3)
// =============================================================================
// Phase 1: acknowledged GAME_DETECTED messages, logged PGN length.
// Phase 2: also handles ANALYSIS_COMPLETE messages carrying the full
//          per-move evaluation array from engine.js.
//
// The service worker currently just logs and acknowledges. In Phase 3+ it
// will store results, coordinate between tabs, and trigger UI updates.
// =============================================================================

// ── Lifecycle events ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[ChessReviewer] Extension installed/updated.", details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[ChessReviewer] Browser started — service worker active.");
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(
    "[ChessReviewer:background] Message received:", message.type,
    "from tab:", sender.tab?.id
  );

  switch (message.type) {

    // ── Phase 1: raw PGN extracted ──────────────────────────────────────────
    case "GAME_DETECTED":
      console.log(
        "[ChessReviewer:background] Game detected. PGN length:",
        message.pgn?.length ?? 0
      );
      sendResponse({ status: "acknowledged", phase: 1 });
      break;

    // ── Phase 2: full engine analysis complete ──────────────────────────────
    case "ANALYSIS_COMPLETE":
      const evals = message.evaluations ?? [];
      console.log(
        `[ChessReviewer:background] Analysis complete. ${evals.length} moves evaluated.`
      );

      // Log a summary for debugging in the service worker console
      // (accessible via chrome://extensions → service worker link)
      evals.forEach(e => {
        console.log(
          `[ChessReviewer:background]  Move ${e.moveIndex} | ` +
          `${e.color} played ${e.played} | ` +
          `Best: ${e.bestMove} | Eval: ${e.evaluation}`
        );
      });

      sendResponse({ status: "acknowledged", phase: 2, moveCount: evals.length });
      break;

    // ── Unknown message type ────────────────────────────────────────────────
    default:
      console.warn("[ChessReviewer:background] Unknown message type:", message.type);
      sendResponse({ status: "unknown_type" });
  }

  // Keep the channel open for async responses in future phases
  return true;
});