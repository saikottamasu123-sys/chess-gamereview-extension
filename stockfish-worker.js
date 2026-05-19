// =============================================================================
// stockfish-worker.js — Web Worker for Stockfish engine
// =============================================================================
// This worker supports the "plain postMessage" stockfish.js API, which is
// what most pre-built stockfish.js distributions use.
//
// In this API (used by nmrugg/stockfish.js and variants):
//   - importScripts("stockfish.js") makes the engine start immediately
//   - The engine communicates via self.postMessage (output) and self.onmessage (input)
//   - There is NO Stockfish() factory function — the engine IS the worker
//
// Because of this, we cannot use the worker as a mere relay. Instead we
// load stockfish.js directly into this worker context, intercept its
// postMessage output, and forward everything to the main thread.
// =============================================================================

console.log("[ChessReviewer:worker] stockfish-worker.js started.");

// The main thread sends us the stockfish script URL as the very first message.
self.onmessage = function bootstrap(e) {
  if (e.data.type !== "INIT") {
    console.warn("[ChessReviewer:worker] Received message before INIT:", e.data);
    return;
  }

  const stockfishUrl = e.data.stockfishUrl;
  console.log("[ChessReviewer:worker] Loading Stockfish from:", stockfishUrl);

  // ── Intercept stockfish output BEFORE loading it ──────────────────────────
  // stockfish.js calls self.postMessage() to output UCI lines (plain strings).
  // We override postMessage here to wrap those strings in our envelope
  // before relaying to the main thread.
  const realPostMessage = self.postMessage.bind(self);

  self.postMessage = function(data) {
    if (typeof data === "string") {
      realPostMessage({ type: "ENGINE_OUTPUT", line: data });
    } else {
      realPostMessage(data);
    }
  };

  // ── Load stockfish.js ─────────────────────────────────────────────────────
  try {
    importScripts(stockfishUrl);
    console.log("[ChessReviewer:worker] Stockfish script loaded successfully.");
  } catch (err) {
    console.error("[ChessReviewer:worker] importScripts failed:", err);
    realPostMessage({ type: "WORKER_ERROR", error: String(err) });
    return;
  }

  // ── Wrap stockfish's own message handler ──────────────────────────────────
  // After importScripts, stockfish.js has registered its own self.onmessage.
  // Our main thread sends { type: "UCI_COMMAND", command: "uci" } objects.
  // We need to unwrap those and pass plain strings to stockfish's handler.
  const stockfishMessageHandler = self.onmessage;

  self.onmessage = function handleMessage(e) {
    const msg = e.data;

    if (msg && msg.type === "UCI_COMMAND") {
      console.log("[ChessReviewer:worker] → Stockfish:", msg.command);
      if (stockfishMessageHandler) {
        stockfishMessageHandler({ data: msg.command });
      }
    } else if (typeof msg === "string") {
      if (stockfishMessageHandler) {
        stockfishMessageHandler({ data: msg });
      }
    } else {
      console.warn("[ChessReviewer:worker] Unknown message type:", msg);
    }
  };

  // Tell the main thread we are ready
  realPostMessage({ type: "WORKER_READY" });
  console.log("[ChessReviewer:worker] Ready — sent WORKER_READY to main thread.");
};