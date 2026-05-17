// =============================================================================
// content.js — Injected into https://www.chess.com/game/live/*
// =============================================================================
// Phase 1 responsibilities:
//   1. Confirm successful injection
//   2. Detect when a game has finished (chess.com is a SPA, so we watch the DOM)
//   3. Extract the PGN using multiple fallback strategies
//   4. Print the PGN to the console
//   5. Notify background.js so future phases can act on it
//
// Architecture note: each concern is broken into its own clearly-named
// function so Phase 2+ can import or extend them without rewriting this file.
// =============================================================================

console.log("[ChessReviewer] content.js injected into", window.location.href);

// =============================================================================
// SECTION 1 — Configuration & Constants
// =============================================================================

const CONFIG = {
  // How long (ms) to wait after a "game over" signal before trying to extract
  // PGN. The DOM may still be updating when the signal fires.
  extractionDelay: 4000,

  // How often (ms) to poll for the game-over state as a fallback
  pollInterval: 2000,

  // Maximum polling attempts before giving up
  maxPollAttempts: 60, // 60 × 2s = 2 minutes

  // MutationObserver watch target (we observe the whole body for SPA changes)
  observerTarget: document.body,
};

// =============================================================================
// SECTION 2 — Game-Over Detection
// =============================================================================

/**
 * Checks the DOM for signals that the current game has ended.
 * Chess.com renders a game-over modal/banner when a result is determined.
 *
 * NOTE: These selectors were accurate as of 2024-2025. If chess.com
 * redesigns their frontend the class names here will need updating.
 *
 * @returns {boolean} true if game appears to be over
 */
function isGameOver() {
  // Strategy A: look for the game-over modal that chess.com shows
  const modalSelectors = [
    ".game-over-modal-content",       // primary modal wrapper
    "[class*='game-over']",           // any element whose class contains 'game-over'
    "[class*='GameOver']",            // camelCase variant
    ".board-modal-container",         // generic board modal (appears at game end)
    ".result-modal",                  // older chess.com layout
  ];

  for (const sel of modalSelectors) {
    if (document.querySelector(sel)) {
      console.log(`[ChessReviewer] Game-over signal found via selector: "${sel}"`);
      return true;
    }
  }

  // Strategy B: look for a result badge/text ("1-0", "0-1", "½-½")
  const pageText = document.body.innerText;
  const resultPattern = /\b(1-0|0-1|½-½|1\/2-1\/2)\b/;
  if (resultPattern.test(pageText)) {
    console.log("[ChessReviewer] Game-over signal found via result string in page text.");
    return true;
  }

  return false;
}

// =============================================================================
// SECTION 3 — PGN Extraction (multiple strategies with fallbacks)
// =============================================================================

/**
 * Master extraction function. Tries each strategy in order and returns the
 * first successful result, or null if all strategies fail.
 *
 * @returns {string|null} PGN string or null
 */
function extractPGN() {
  console.log("[ChessReviewer] Starting PGN extraction...");

  const strategies = [
    { name: "Window variable scan", fn: extractFromWindowVariables },
    { name: "DOM move list scrape", fn: extractFromDOM },
    { name: "data-* attribute scan", fn: extractFromDataAttributes },
  ];

  for (const { name, fn } of strategies) {
    console.log(`[ChessReviewer] Trying strategy: "${name}"`);
    try {
      const result = fn();
      if (result) {
        console.log(`[ChessReviewer] ✅ Strategy "${name}" succeeded.`);
        return result;
      } else {
        console.log(`[ChessReviewer] ⚠️  Strategy "${name}" returned nothing.`);
      }
    } catch (err) {
      console.warn(`[ChessReviewer] ❌ Strategy "${name}" threw:`, err);
    }
  }

  console.error("[ChessReviewer] All extraction strategies failed.");
  return null;
}

// ── Strategy A: Window variable scan ─────────────────────────────────────────
// Chess.com often exposes game state on the window object under various keys.
// These keys have changed over time, so we check a list of candidates.

function extractFromWindowVariables() {
  // Known window-level game state keys (update this list as chess.com evolves)
  const candidates = [
    "CHESS_GAME",
    "chesscom",
    "gameSetup",
    "gameData",
    "GameSetup",
  ];

  for (const key of candidates) {
    const obj = window[key];
    if (!obj) continue;

    console.log(`[ChessReviewer:window] Found window.${key}:`, typeof obj);

    // Look for a .pgn property directly
    if (typeof obj.pgn === "string" && obj.pgn.length > 0) {
      console.log(`[ChessReviewer:window] Found pgn on window.${key}.pgn`);
      return obj.pgn;
    }

    // Recursively search one level deep for nested pgn strings
    if (typeof obj === "object") {
      for (const subKey of Object.keys(obj)) {
        const sub = obj[subKey];
        if (typeof sub === "string" && sub.startsWith("[Event") ) {
          console.log(`[ChessReviewer:window] Found PGN at window.${key}.${subKey}`);
          return sub;
        }
        if (typeof sub === "object" && sub !== null && typeof sub.pgn === "string") {
          console.log(`[ChessReviewer:window] Found PGN at window.${key}.${subKey}.pgn`);
          return sub.pgn;
        }
      }
    }
  }

  return null;
}

// ── Strategy B: DOM move list scrape ─────────────────────────────────────────
// Chess.com renders moves in a move list panel. We scrape those and build a
// minimal PGN string from them.
//
// This is the most resilient strategy against window variable changes, but
// produces a simpler PGN (without headers/clock times/annotations).

function extractFromDOM() {
  // ── Step 1: try to grab main-line-ply nodes directly (confirmed working 2025) ──
  // Chess.com uses class "node white-move main-line-ply" / "node black-move main-line-ply"
  // These exist at the document level, no container needed.
  const directSelectors = [
    ".main-line-ply",                        // confirmed class as of 2025
    "[class*='main-line-ply']",              // variant
  ];

  for (const sel of directSelectors) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) {
      console.log(`[ChessReviewer:DOM] Found ${nodes.length} main-line-ply nodes with "${sel}"`);
      return buildPGNFromNodes(Array.from(nodes));
    }
  }

  // ── Step 2: fall back to container + child approach ───────────────────────
  const moveListSelectors = [
    ".move-list",
    "[class*='moves-list']",
    "[class*='MoveList']",
    ".vertical-move-list",
    "[data-cy='move-list']",
  ];

  for (const sel of moveListSelectors) {
    const container = document.querySelector(sel);
    if (!container) continue;

    console.log(`[ChessReviewer:DOM] Found move list container: "${sel}"`);

    const moveSelectors = [
      "[class*='main-line-ply']",
      "[class*='node']",
      ".move",
      "span[data-move]",
    ];

    for (const moveSel of moveSelectors) {
      const nodes = container.querySelectorAll(moveSel);
      if (nodes.length > 0) {
        console.log(`[ChessReviewer:DOM] Found ${nodes.length} move nodes with "${moveSel}"`);
        return buildPGNFromNodes(Array.from(nodes));
      }
    }
  }

  console.log("[ChessReviewer:DOM] No move nodes found.");
  return null;
}

/**
 * Given an array of DOM nodes representing individual plies (half-moves),
 * extract their text and format into a PGN move string.
 */
function buildPGNFromNodes(nodes) {
  // Each node contains a move like "e4", "Nf3", "O-O" etc.
  // We also look for a nested element with the actual move text
  // since chess.com sometimes wraps it in a <span class="node-highlight-content">
  const moves = nodes.map(n => {
    // Try to find a more specific inner element first
    const inner = n.querySelector("[class*='highlight-content'], [class*='move-san'], .node-highlight-content");
    const text = (inner || n).textContent.trim();
    return text;
  }).filter(t => t.length > 0 && !/^\d+\.+$/.test(t)); // drop bare move numbers like "1."

  if (moves.length === 0) return null;

  console.log(`[ChessReviewer:DOM] Extracted ${moves.length} moves:`, moves.slice(0, 6), "...");

  // Format into standard PGN move text: "1. e4 e5 2. Nf3 Nc6 ..."
  let pgn = "[Event \"chess.com Game\"]\n[Site \"chess.com\"]\n\n";
  moves.forEach((move, i) => {
    if (i % 2 === 0) pgn += `${Math.floor(i / 2) + 1}. `;
    pgn += `${move} `;
  });

  return pgn.trim();
}

// ── Strategy C: data-* attribute scan ────────────────────────────────────────
// Chess.com sometimes embeds game data in data-* attributes on specific
// elements (e.g., the board component).

function extractFromDataAttributes() {
  const targets = [
    document.querySelector("[data-board-id]"),
    document.querySelector("[data-game-id]"),
    document.querySelector("chess-board"),     // web component tag
    document.querySelector("wc-chess-board"),  // another variant
  ];

  for (const el of targets) {
    if (!el) continue;
    console.log("[ChessReviewer:data-attr] Inspecting element:", el.tagName, el.className);

    // Dump all data attributes for debugging
    const dataset = el.dataset;
    for (const [key, value] of Object.entries(dataset)) {
      console.log(`[ChessReviewer:data-attr]   data-${key} =`, value.substring(0, 80));
      if (value.startsWith("[Event") || value.includes("pgn")) {
        return value;
      }
    }
  }

  return null;
}

// =============================================================================
// SECTION 4 — Main Orchestration
// =============================================================================

let gameDetected = false; // guard against firing multiple times per game

/**
 * Called when we believe the game is over. Waits briefly for the DOM to
 * settle, then attempts extraction and reports results.
 */
function onGameOver() {
  if (gameDetected) {
    console.log("[ChessReviewer] Game-over already handled — skipping duplicate trigger.");
    return;
  }
  gameDetected = true;

  console.log(`[ChessReviewer] ⏳ Game over detected. Waiting ${CONFIG.extractionDelay}ms for DOM to settle...`);

  setTimeout(() => {
    const pgn = extractPGN();

    if (pgn) {
      console.log("=== [ChessReviewer] ✅ PGN EXTRACTED ===");
      console.log(pgn);
      console.log("=== [ChessReviewer] END PGN ===");

      // Notify background.js (Phase 2 will act on this)
      chrome.runtime.sendMessage({ type: "GAME_DETECTED", pgn }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[ChessReviewer] Background message failed:", chrome.runtime.lastError.message);
        } else {
          console.log("[ChessReviewer] Background acknowledged:", response);
        }
      });
    } else {
      console.warn("[ChessReviewer] ⚠️ PGN extraction failed. Manual inspection needed.");
      console.log("[ChessReviewer] Dumping window keys for debugging:", Object.keys(window).filter(k => /chess|game|pgn/i.test(k)));
    }
  }, CONFIG.extractionDelay);
}

// =============================================================================
// SECTION 5 — Watchers (MutationObserver + polling fallback)
// =============================================================================

/**
 * MutationObserver watches for DOM changes that indicate a game ended.
 * This is the primary detection mechanism on chess.com's SPA.
 */
function startMutationObserver() {
  console.log("[ChessReviewer] Starting MutationObserver...");

  const observer = new MutationObserver((mutations) => {
    // Don't bother scanning every mutation if we already fired
    if (gameDetected) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const html = node.outerHTML || "";
        if (/game.?over|result.?modal|GameOver/i.test(html) || /board.?modal/i.test(html)) {
          console.log("[ChessReviewer:observer] Game-over node detected in mutation.");
          observer.disconnect(); // stop watching once we've found it
          onGameOver();
          return;
        }
      }
    }

    // Also re-check the overall page state on each batch of mutations
    if (isGameOver()) {
      console.log("[ChessReviewer:observer] isGameOver() returned true during mutation.");
      observer.disconnect();
      onGameOver();
    }
  });

  observer.observe(CONFIG.observerTarget, {
    childList: true,   // watch for added/removed child nodes
    subtree: true,     // watch the entire subtree under body
  });

  return observer;
}

/**
 * Polling fallback — in case the MutationObserver misses the event.
 * Checks isGameOver() every CONFIG.pollInterval ms.
 */
function startPollingFallback() {
  console.log("[ChessReviewer] Starting polling fallback...");
  let attempts = 0;

  const interval = setInterval(() => {
    attempts++;

    if (gameDetected) {
      clearInterval(interval);
      return;
    }

    if (attempts > CONFIG.maxPollAttempts) {
      console.log("[ChessReviewer] Polling max attempts reached. Stopping.");
      clearInterval(interval);
      return;
    }

    if (isGameOver()) {
      console.log(`[ChessReviewer] Polling detected game over on attempt ${attempts}.`);
      clearInterval(interval);
      onGameOver();
    }
  }, CONFIG.pollInterval);

  return interval;
}

/**
 * Handles chess.com SPA navigation — when the user starts a new game
 * the URL changes but the page doesn't fully reload, so we need to reset.
 */
function handleSPANavigation() {
  let lastUrl = window.location.href;

  const navObserver = new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      console.log(`[ChessReviewer] SPA navigation detected: ${lastUrl} → ${currentUrl}`);
      lastUrl = currentUrl;

      // Reset state for the new game
      gameDetected = false;

      // Restart watchers for the new game page
      startMutationObserver();
      startPollingFallback();
    }
  });

  // Observe the <title> element — it reliably changes on SPA route transitions
  const titleEl = document.querySelector("title");
  if (titleEl) {
    navObserver.observe(titleEl, { childList: true });
    console.log("[ChessReviewer] SPA navigation watcher active on <title>.");
  } else {
    // Fallback: observe body for URL changes
    navObserver.observe(document.body, { childList: true, subtree: false });
    console.log("[ChessReviewer] SPA navigation watcher active on <body> (title not found).");
  }
}

// =============================================================================
// SECTION 6 — Entry Point
// =============================================================================

(function init() {
  console.log("[ChessReviewer] Initializing Phase 1...");

  // Check if the game is already over when we inject (e.g., user opened a
  // completed game link directly)
  if (isGameOver()) {
    console.log("[ChessReviewer] Game already over on injection.");
    onGameOver();
    return;
  }

  // Otherwise watch for it
  startMutationObserver();
  startPollingFallback();
  handleSPANavigation();

  console.log("[ChessReviewer] Phase 1 ready. Watching for game end...");
})();