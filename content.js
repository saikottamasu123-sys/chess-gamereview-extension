// =============================================================================
// content.js — Injected into https://www.chess.com/game/live/*
// =============================================================================
// Phase 1 responsibilities (unchanged):
//   1. Detect when a game has finished via MutationObserver + polling
//   2. Extract the PGN by scraping .main-line-ply DOM nodes
//   3. Notify background.js
//
// Phase 2 additions:
//   4. Initialize the ChessEngine (engine.js) on page load
//   5. When a game ends and PGN is extracted, pass it to ChessEngine.analyzeGame()
//   6. Print per-move evaluations to the console
//   7. Tear down and reinitialize the engine on SPA navigation
//
// Dependencies loaded before this file (see manifest.json):
//   lib/chess.min.js → provides Chess() constructor used by engine.js
//   engine.js        → provides ChessEngine global object
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
  const modalSelectors = [
    ".game-over-modal-content",
    "[class*='game-over']",
    "[class*='GameOver']",
    ".board-modal-container",
    ".result-modal",
  ];

  for (const sel of modalSelectors) {
    if (document.querySelector(sel)) {
      console.log(`[ChessReviewer] Game-over signal found via selector: "${sel}"`);
      return true;
    }
  }

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

function extractFromWindowVariables() {
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

    if (typeof obj.pgn === "string" && obj.pgn.length > 0) {
      console.log(`[ChessReviewer:window] Found pgn on window.${key}.pgn`);
      return obj.pgn;
    }

    if (typeof obj === "object") {
      for (const subKey of Object.keys(obj)) {
        const sub = obj[subKey];
        if (typeof sub === "string" && sub.startsWith("[Event")) {
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

function extractFromDOM() {
  const directSelectors = [
    ".main-line-ply",
    "[class*='main-line-ply']",
  ];

  for (const sel of directSelectors) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) {
      console.log(`[ChessReviewer:DOM] Found ${nodes.length} main-line-ply nodes with "${sel}"`);
      return buildPGNFromNodes(Array.from(nodes));
    }
  }

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

function buildPGNFromNodes(nodes) {
  const moves = nodes.map(n => {
    const inner = n.querySelector("[class*='highlight-content'], [class*='move-san'], .node-highlight-content");
    const text = (inner || n).textContent.trim();
    return text;
  }).filter(t => t.length > 0 && !/^\d+\.+$/.test(t));

  if (moves.length === 0) return null;

  console.log(`[ChessReviewer:DOM] Extracted ${moves.length} moves:`, moves.slice(0, 6), "...");

  let pgn = "[Event \"chess.com Game\"]\n[Site \"chess.com\"]\n\n";
  moves.forEach((move, i) => {
    if (i % 2 === 0) pgn += `${Math.floor(i / 2) + 1}. `;
    pgn += `${move} `;
  });

  return pgn.trim();
}

// ── Strategy C: data-* attribute scan ────────────────────────────────────────

function extractFromDataAttributes() {
  const targets = [
    document.querySelector("[data-board-id]"),
    document.querySelector("[data-game-id]"),
    document.querySelector("chess-board"),
    document.querySelector("wc-chess-board"),
  ];

  for (const el of targets) {
    if (!el) continue;
    console.log("[ChessReviewer:data-attr] Inspecting element:", el.tagName, el.className);

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
// SECTION 4 — Phase 2: Engine Integration
// =============================================================================

/**
 * Initializes the Stockfish engine. Called once on page load (and again after
 * SPA navigation resets the page).
 *
 * We initialize eagerly so the engine is warmed up and ready to analyze as
 * soon as the game ends — avoiding a delay between game end and analysis start.
 */
async function initEngine() {
  console.log("[ChessReviewer] Initializing Stockfish engine...");

  try {
    await ChessEngine.init();
    console.log("[ChessReviewer] ✅ Engine initialized and ready.");
  } catch (err) {
    console.error("[ChessReviewer] ❌ Engine initialization failed:", err);
    console.warn("[ChessReviewer] Analysis will be skipped. Check that lib/stockfish.js exists.");
  }
}

/**
 * Runs after PGN extraction succeeds. Passes the PGN to the engine for
 * move-by-move analysis.
 *
 * @param {string} pgn — PGN string from extractPGN()
 */
async function runAnalysis(pgn) {
  if (!ChessEngine.isReady) {
    console.warn("[ChessReviewer] Engine is not ready — skipping analysis.");
    console.warn("[ChessReviewer] This may mean stockfish.js failed to load.");
    return;
  }

  console.log("[ChessReviewer] Starting Phase 2 analysis pipeline...");

  try {
    const evaluations = await ChessEngine.analyzeGame(pgn);

    if (evaluations.length === 0) {
      console.warn("[ChessReviewer] No evaluations produced. PGN may be malformed.");
      return;
    }

    console.log("=== [ChessReviewer] ✅ ANALYSIS RESULTS ===");
    evaluations.forEach(e => {
      const moveLabel = `${e.moveNumber}.${e.color === "Black" ? ".." : ""} ${e.played}`;
      console.log(
        `Move ${String(e.moveIndex).padStart(2, "0")} | ${moveLabel.padEnd(12)} | ` +
        `Best: ${String(e.bestMove).padEnd(8)} | Eval: ${e.evaluation}`
      );
    });
    console.log("=== [ChessReviewer] END ANALYSIS ===");

    // Notify background.js with full evaluation data for future phases
    chrome.runtime.sendMessage({
      type: "ANALYSIS_COMPLETE",
      evaluations,
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[ChessReviewer] Background message failed:", chrome.runtime.lastError.message);
      } else {
        console.log("[ChessReviewer] Background acknowledged analysis:", response);
      }
    });

  } catch (err) {
    console.error("[ChessReviewer] Analysis pipeline failed:", err);
  }
}

// =============================================================================
// SECTION 5 — Main Orchestration
// =============================================================================

let gameDetected = false;

/**
 * Called when we believe the game is over. Waits briefly for the DOM to
 * settle, then extracts the PGN and triggers engine analysis.
 */
function onGameOver() {
  if (gameDetected) {
    console.log("[ChessReviewer] Game-over already handled — skipping duplicate trigger.");
    return;
  }
  gameDetected = true;

  console.log(`[ChessReviewer] ⏳ Game over detected. Waiting ${CONFIG.extractionDelay}ms for DOM to settle...`);

  setTimeout(async () => {
    const pgn = extractPGN();

    if (pgn) {
      console.log("=== [ChessReviewer] ✅ PGN EXTRACTED ===");
      console.log(pgn);
      console.log("=== [ChessReviewer] END PGN ===");

      // Phase 1: notify background
      chrome.runtime.sendMessage({ type: "GAME_DETECTED", pgn }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[ChessReviewer] Background message failed:", chrome.runtime.lastError.message);
        } else {
          console.log("[ChessReviewer] Background acknowledged:", response);
        }
      });

      // Phase 2: run engine analysis
      await runAnalysis(pgn);

    } else {
      console.warn("[ChessReviewer] ⚠️ PGN extraction failed. Manual inspection needed.");
      console.log("[ChessReviewer] Dumping window keys for debugging:", Object.keys(window).filter(k => /chess|game|pgn/i.test(k)));
    }
  }, CONFIG.extractionDelay);
}

// =============================================================================
// SECTION 6 — Watchers (MutationObserver + polling fallback)
// =============================================================================

function startMutationObserver() {
  console.log("[ChessReviewer] Starting MutationObserver...");

  const observer = new MutationObserver((mutations) => {
    if (gameDetected) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const html = node.outerHTML || "";
        if (/game.?over|result.?modal|GameOver/i.test(html) || /board.?modal/i.test(html)) {
          console.log("[ChessReviewer:observer] Game-over node detected in mutation.");
          observer.disconnect();
          onGameOver();
          return;
        }
      }
    }

    if (isGameOver()) {
      console.log("[ChessReviewer:observer] isGameOver() returned true during mutation.");
      observer.disconnect();
      onGameOver();
    }
  });

  observer.observe(CONFIG.observerTarget, {
    childList: true,
    subtree: true,
  });

  return observer;
}

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
 * Handles chess.com SPA navigation.
 * On route change: destroy the old engine, reset state, reinitialize.
 */
function handleSPANavigation() {
  let lastUrl = window.location.href;

  const navObserver = new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      console.log(`[ChessReviewer] SPA navigation detected: ${lastUrl} → ${currentUrl}`);
      lastUrl = currentUrl;

      // Tear down Phase 2 engine before resetting
      ChessEngine.destroy();

      // Reset Phase 1 state
      gameDetected = false;

      // Reinitialize everything for the new game
      initEngine();
      startMutationObserver();
      startPollingFallback();
    }
  });

  const titleEl = document.querySelector("title");
  if (titleEl) {
    navObserver.observe(titleEl, { childList: true });
    console.log("[ChessReviewer] SPA navigation watcher active on <title>.");
  } else {
    navObserver.observe(document.body, { childList: true, subtree: false });
    console.log("[ChessReviewer] SPA navigation watcher active on <body> (title not found).");
  }
}

// =============================================================================
// SECTION 7 — Entry Point
// =============================================================================

(async function init() {
  console.log("[ChessReviewer] Initializing Phase 2...");

  // Start engine warmup immediately — don't wait for game over
  await initEngine();

  // Check if the game is already over on injection
  if (isGameOver()) {
    console.log("[ChessReviewer] Game already over on injection.");
    onGameOver();
    return;
  }

  // Watch for game end
  startMutationObserver();
  startPollingFallback();
  handleSPANavigation();

  console.log("[ChessReviewer] Phase 2 ready. Engine warming up. Watching for game end...");
})();