// Health dashboard worker — stub process.
// Real job logic lands in a later issue; this proves the single
// image can also run a non-web process (`node worker/index.mjs`).

console.log("[worker] started", new Date().toISOString());

const HEARTBEAT_MS = 60_000;
const timer = setInterval(() => {
  console.log("[worker] heartbeat", new Date().toISOString());
}, HEARTBEAT_MS);

function shutdown(signal) {
  console.log(`[worker] received ${signal}, shutting down`);
  clearInterval(timer);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
