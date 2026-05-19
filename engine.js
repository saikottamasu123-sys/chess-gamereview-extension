// =============================================================================
// engine.js — Stockfish engine manager (runs on the main thread)
// =============================================================================
// This file is the bridge between content.js (which has the PGN and game
// logic) and stockfish-worker.js (which runs the engine on a separate thread).
//
// Responsibilities:
//   1. Spin up the Web Worker
//   2. Perform the UCI handshake (uci → uciok → isready → readyok)
//   3. Expose a clean async API:  analyzePosition(fen) → { bestMove, eval }
//   4. Replay a full PGN game move-by-move using chess.js for FEN generation
//   5. Store all per-move evaluations in a structured array
//
// Dependencies (loaded before this file by manifest.json):
//   - lib/chess.min.js  (chess.js — move replay & FEN generation)
//
// Architecture note: engine.js exposes a single global object `ChessEngine`
// so content.js can call it without module imports (we're using plain scripts).
// =============================================================================

console.log("[ChessReviewer:engine] engine.js loaded.");

// =============================================================================
// SECTION 1 — Constants & Configuration
// =============================================================================

const ENGINE_CONFIG = {
  // Stockfish search depth. Higher = stronger but slower.
  // 15 is a good balance for game review (takes ~1-3s per position).
  depth: 15,

  // Timeout (ms) per position before we give up and move on.
  // Prevents a single position from hanging the review forever.
  positionTimeout: 10000,

  // Delay (ms) between consecutive position analyses to keep the browser
  // responsive and avoid overwhelming the worker message queue.
  betweenMovesDelay: 100,
};

// =============================================================================
// SECTION 2 — ChessEngine object (public API)
// =============================================================================

const ChessEngine = (() => {

  // ── Private state ───────────────────────────────────────────────────────────
  let worker = null;          // The Web Worker instance
  let workerReady = false;    // True after "readyok" received from engine
  let uciReady = false;       // True after "uciok" received

  // Per-position analysis state — reset for each analyzePosition() call
  let currentResolve = null;  // Promise resolver waiting for "bestmove"
  let currentReject = null;   // Promise rejecter for timeout handling
  let currentTimeoutId = null;
  let bestMoveBuffer = null;  // Latest bestmove line from engine
  let evalBuffer = null;      // Latest evaluation from "info depth" lines

  // Accumulated results for a full game review
  let gameEvaluations = [];

  // ── Worker initialization ───────────────────────────────────────────────────

  /**
   * Creates the Web Worker and performs the UCI handshake.
   * Returns a Promise that resolves when the engine is ready to accept
   * position commands.
   */
  function init() {
    return new Promise((resolve, reject) => {
      console.log("[ChessReviewer:engine] Initializing engine worker...");

      // MV3 FIX: Content scripts cannot call new Worker(chrome.runtime.getURL(...))
      // directly — Chrome blocks it with a DOMException. The workaround is to
      // fetch the worker script text, wrap it in a Blob, and create the Worker
      // from the Blob URL instead. This is the standard MV3 pattern.
      const workerUrl    = chrome.runtime.getURL("stockfish-worker.js");
      const stockfishUrl = chrome.runtime.getURL("lib/stockfish.js");

      fetch(workerUrl)
        .then(r => r.text())
        .then(workerCode => {
          const blob = new Blob([workerCode], { type: "application/javascript" });
          const blobUrl = URL.createObjectURL(blob);

          try {
            worker = new Worker(blobUrl);
            URL.revokeObjectURL(blobUrl); // free memory after worker is created
          } catch (err) {
            console.error("[ChessReviewer:engine] Failed to create Worker from Blob:", err);
            reject(err);
            return;
          }

          // Worker is created — set up message handlers then send INIT
          setupWorker(resolve, reject, stockfishUrl);
        })
        .catch(err => {
          console.error("[ChessReviewer:engine] Failed to fetch worker script:", err);
          reject(err);
        });
    });
  }

  function setupWorker(resolve, reject, stockfishUrl) {

      // ── Handle messages from the worker ──────────────────────────────────
      worker.onmessage = (e) => {
        const msg = e.data;

        switch (msg.type) {

          // Worker has loaded Stockfish and is ready for our INIT command
          case "WORKER_READY":
            console.log("[ChessReviewer:engine] Worker ready. Sending UCI handshake...");
            sendCommand("uci");
            break;

          // Raw UCI line from the engine — route to the appropriate handler
          case "ENGINE_OUTPUT":
            handleEngineOutput(msg.line, resolve, reject);
            break;

          case "WORKER_ERROR":
            console.error("[ChessReviewer:engine] Worker error:", msg.error);
            reject(new Error(msg.error));
            break;

          default:
            console.warn("[ChessReviewer:engine] Unknown worker message:", msg);
        }
      };

      worker.onerror = (err) => {
        console.error("[ChessReviewer:engine] Worker threw an error:", err);
        reject(err);
      };

      // Kick off loading — send the Stockfish script URL to the worker
      worker.postMessage({ type: "INIT", stockfishUrl });
  }

  // ── UCI command sender ──────────────────────────────────────────────────────

  /**
   * Sends a raw UCI command string to the worker.
   */
  function sendCommand(cmd) {
    if (!worker) {
      console.error("[ChessReviewer:engine] sendCommand called before worker exists.");
      return;
    }
    console.log("[ChessReviewer:engine] Sending UCI command:", cmd);
    worker.postMessage({ type: "UCI_COMMAND", command: cmd });
  }

  // ── Engine output parser ────────────────────────────────────────────────────

  /**
   * Parses each line that Stockfish sends back.
   *
   * Important UCI response lines:
   *   "uciok"        — engine acknowledged UCI mode
   *   "readyok"      — engine is ready for position commands
   *   "info depth N ... score cp X ... pv <move>"  — search progress
   *   "info depth N ... score mate X ..."           — forced mate found
   *   "bestmove <move> [ponder <move>]"             — final answer for this position
   */
  function handleEngineOutput(line, initResolve, initReject) {
    console.log("[ChessReviewer:engine] ← Engine:", line);

    // ── Handshake responses ─────────────────────────────────────────────────
    if (line === "uciok") {
      uciReady = true;
      console.log("[ChessReviewer:engine] UCI handshake complete. Sending isready...");
      sendCommand("isready");
      return;
    }

    if (line === "readyok") {
      workerReady = true;
      console.log("[ChessReviewer:engine] Engine ready. Handshake complete ✅");
      if (initResolve) initResolve(); // resolve the init() promise
      return;
    }

    // ── Search info lines ───────────────────────────────────────────────────
    // We only care about lines from the maximum depth since they're most accurate.
    // Example: "info depth 15 seldepth 22 multipv 1 score cp -43 nodes 1234 ... pv e2e4 ..."
    if (line.startsWith("info depth")) {
      const depthMatch = line.match(/depth (\d+)/);
      const depth = depthMatch ? parseInt(depthMatch[1]) : 0;

      // Only store evaluations at the target depth (or the highest we get)
      if (depth >= 1) {
        evalBuffer = parseEvalFromInfo(line);
      }
      return;
    }

    // ── Best move response ──────────────────────────────────────────────────
    // "bestmove e2e4 ponder e7e5"  OR just  "bestmove e2e4"
    if (line.startsWith("bestmove")) {
      const parts = line.split(" ");
      bestMoveBuffer = parts[1] || "(none)";

      console.log("[ChessReviewer:engine] Best move:", bestMoveBuffer, "| Eval:", evalBuffer);

      // Clear the timeout and resolve the waiting analyzePosition() promise
      if (currentTimeoutId) clearTimeout(currentTimeoutId);
      if (currentResolve) {
        currentResolve({
          bestMove: bestMoveBuffer,
          evaluation: evalBuffer,
        });
        currentResolve = null;
        currentReject = null;
      }
    }
  }

  /**
   * Extracts a human-readable evaluation from an "info depth" UCI line.
   *
   * Stockfish reports evaluation in one of two formats:
   *   "score cp -43"    → centipawns (negative = black is better)
   *   "score mate 3"    → forced mate in 3 moves
   *
   * We normalise centipawns to pawns (divide by 100) for readability.
   * Mate scores are returned as "+M3" or "-M3" strings.
   *
   * @param {string} line — raw UCI info line
   * @returns {string|number} evaluation value
   */
  function parseEvalFromInfo(line) {
    // Mate score
    const mateMatch = line.match(/score mate (-?\d+)/);
    if (mateMatch) {
      const mateIn = parseInt(mateMatch[1]);
      return mateIn > 0 ? `+M${mateIn}` : `-M${Math.abs(mateIn)}`;
    }

    // Centipawn score
    const cpMatch = line.match(/score cp (-?\d+)/);
    if (cpMatch) {
      const cp = parseInt(cpMatch[1]);
      // Round to 2 decimal places for cleanliness
      return Math.round(cp) / 100;
    }

    return null;
  }

  // ── Position analysis ───────────────────────────────────────────────────────

  /**
   * Analyzes a single FEN position and returns the best move + evaluation.
   *
   * @param {string} fen — FEN string for the position to analyze
   * @returns {Promise<{bestMove: string, evaluation: number|string}>}
   */
  function analyzePosition(fen) {
    return new Promise((resolve, reject) => {
      if (!workerReady) {
        reject(new Error("Engine not ready yet."));
        return;
      }

      // Reset per-position buffers
      evalBuffer = null;
      bestMoveBuffer = null;
      currentResolve = resolve;
      currentReject = reject;

      // Set a timeout in case the engine hangs or takes too long
      currentTimeoutId = setTimeout(() => {
        console.warn("[ChessReviewer:engine] Position analysis timed out. FEN:", fen);
        sendCommand("stop"); // tell engine to wrap up immediately
        // resolve with whatever we have rather than reject, so the game
        // review can continue on the next move
        resolve({
          bestMove: bestMoveBuffer || "(timeout)",
          evaluation: evalBuffer,
        });
        currentResolve = null;
        currentReject = null;
      }, ENGINE_CONFIG.positionTimeout);

      // Send position + go commands
      sendCommand(`position fen ${fen}`);
      sendCommand(`go depth ${ENGINE_CONFIG.depth}`);
    });
  }

  // ── Full game replay ────────────────────────────────────────────────────────

  /**
   * Replays an entire PGN game move-by-move, analyzing each position.
   *
   * Uses chess.js to:
   *   1. Parse the PGN into a move array
   *   2. Generate the FEN after each move
   *
   * Then feeds each FEN to analyzePosition() and stores the result.
   *
   * @param {string} pgn — full PGN string from Phase 1
   * @returns {Promise<Array>} array of per-move evaluation objects
   */
  async function analyzeGame(pgn) {
    console.log("[ChessReviewer:engine] Starting full game analysis...");
    console.log("[ChessReviewer:engine] PGN received:", pgn.substring(0, 120), "...");

    gameEvaluations = [];

    // ── Load PGN into chess.js ──────────────────────────────────────────────
    // Chess() is the chess.js constructor, loaded from lib/chess.min.js
    const chess = new Chess();

    let loaded = false;
    try {
      // chess.js v0.12 uses chess.load_pgn(); v1.x uses chess.loadPgn()
      // We try both for compatibility.
      if (typeof chess.loadPgn === "function") {
        chess.loadPgn(pgn);
        loaded = true;
      } else if (typeof chess.load_pgn === "function") {
        loaded = chess.load_pgn(pgn);
      }
    } catch (err) {
      console.warn("[ChessReviewer:engine] PGN load error:", err.message);
    }

    if (!loaded) {
      // Phase 1 known issue: scraped moves are missing piece letters.
      // Try to recover by extracting just the move text and replaying
      // them one by one, skipping any that are invalid.
      console.warn("[ChessReviewer:engine] PGN load failed — attempting move-by-move fallback.");
      loaded = replayMovesFromPGN(chess, pgn);
    }

    if (!loaded) {
      console.error("[ChessReviewer:engine] Could not parse PGN. Aborting analysis.");
      return [];
    }

    // ── Collect the move history ────────────────────────────────────────────
    // chess.js history() returns the list of moves in SAN notation.
    // We need to replay from the start to get the FEN before each move.
    const history = chess.history({ verbose: true });
    console.log(`[ChessReviewer:engine] Game has ${history.length} moves. Starting analysis...`);

    // Reset to the starting position so we can step through
    chess.reset();

    // ── Analyze move by move ────────────────────────────────────────────────
    for (let i = 0; i < history.length; i++) {
      const moveData = history[i];
      const moveNumber = Math.floor(i / 2) + 1;
      const color = i % 2 === 0 ? "White" : "Black";

      // FEN BEFORE the move is what we evaluate — we want to know what the
      // engine thinks of the position the player faced.
      const fenBefore = chess.fen();

      // Apply the move so the next iteration has the correct board state
      chess.move(moveData.san);

      console.log(`[ChessReviewer:engine] Analyzing move ${moveNumber} (${color}): ${moveData.san}`);
      console.log(`[ChessReviewer:engine] FEN: ${fenBefore}`);

      // Analyze the position — this is async and waits for "bestmove"
      let result;
      try {
        result = await analyzePosition(fenBefore);
      } catch (err) {
        console.error(`[ChessReviewer:engine] analyzePosition failed for move ${i + 1}:`, err);
        result = { bestMove: "(error)", evaluation: null };
      }

      // Build the evaluation record for this move
      const evalRecord = {
        moveIndex: i + 1,
        moveNumber,
        color,
        played: moveData.san,          // The move the player made
        bestMove: result.bestMove,     // What Stockfish recommends
        evaluation: result.evaluation, // Eval of the position BEFORE the move
        fen: fenBefore,
      };

      gameEvaluations.push(evalRecord);

      // ── Console output ────────────────────────────────────────────────────
      console.log(
        `[ChessReviewer] Move ${moveNumber} (${color}) | ` +
        `Played: ${moveData.san} | ` +
        `Best: ${result.bestMove} | ` +
        `Eval: ${result.evaluation}`
      );

      // Small delay between positions to keep the browser responsive
      if (i < history.length - 1) {
        await delay(ENGINE_CONFIG.betweenMovesDelay);
      }
    }

    console.log("=== [ChessReviewer] ✅ FULL GAME ANALYSIS COMPLETE ===");
    console.log(`[ChessReviewer] Total moves analyzed: ${gameEvaluations.length}`);
    console.table(gameEvaluations.map(e => ({
      "#": e.moveIndex,
      "Move": `${e.moveNumber}. ${e.color === "Black" ? "..." : ""}${e.played}`,
      "Best": e.bestMove,
      "Eval": e.evaluation,
    })));

    return gameEvaluations;
  }

  // ── PGN fallback parser ─────────────────────────────────────────────────────

  /**
   * Fallback for when chess.js can't parse the full PGN.
   * Strips PGN headers, extracts individual move tokens, and replays them
   * one by one — skipping any that chess.js rejects as illegal.
   *
   * This handles the Phase 1 known issue where piece letters are missing,
   * though analysis quality will be lower since FENs may be off.
   *
   * @param {Chess} chess — chess.js instance (will be modified in place)
   * @param {string} pgn — raw PGN string
   * @returns {boolean} true if at least some moves were loaded
   */
  function replayMovesFromPGN(chess, pgn) {
    chess.reset();

    // Strip header tags like [Event "..."]
    const body = pgn.replace(/\[.*?\]\s*/g, "").trim();

    // Tokenize: split on whitespace, remove move numbers (e.g. "1.", "12...")
    const tokens = body.split(/\s+/).filter(t => !/^\d+\.+$/.test(t) && t.length > 0);

    let loaded = 0;
    for (const token of tokens) {
      // Skip result tokens
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) break;

      try {
        const result = chess.move(token, { sloppy: true });
        if (result) loaded++;
      } catch (_) {
        console.warn("[ChessReviewer:engine] Skipping unrecognized move token:", token);
      }
    }

    console.log(`[ChessReviewer:engine] Fallback parser loaded ${loaded} moves.`);
    return loaded > 0;
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Returns a copy of the game evaluations array.
   * Phase 3 will call this to perform move classifications.
   */
  function getEvaluations() {
    return [...gameEvaluations];
  }

  /**
   * Terminates the worker. Call this on SPA navigation to free resources.
   */
  function destroy() {
    if (worker) {
      sendCommand("quit");
      worker.terminate();
      worker = null;
      workerReady = false;
      uciReady = false;
      console.log("[ChessReviewer:engine] Engine worker terminated.");
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  return {
    init,
    analyzePosition,
    analyzeGame,
    getEvaluations,
    destroy,
    get isReady() { return workerReady; },
    get config() { return ENGINE_CONFIG; },
  };

})();

console.log("[ChessReviewer:engine] ChessEngine object ready.");