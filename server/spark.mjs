// server/spark.mjs — shared tok/min sparkline math.
//
// Both pipelines feed the per-card tok/min sparkline and the fleet
// aggregate t/min readout. The PTY pipeline (the default) used to never
// update spark — it stayed at Array(15).fill(1), so the fleet readout was
// pinned at a constant ~8000/agent regardless of real throughput (#26).
// Centralizing the rate math here lets jsonlConnector.mjs (PTY) and
// agent.mjs (stream-json) share one implementation, and exports SPARK_SCALE
// so tui/App.jsx denormalizes with the SAME constant instead of a literal.

export const SPARK_LEN = 15;

// Spark stores ratePerMin / SPARK_SCALE so the array holds small values for
// the ▁▂▃▄▅▆▇█ glyphs; the UI multiplies back by SPARK_SCALE to recover
// tokens/min. The server normalizer and the UI denormalizer MUST agree on
// this number or the displayed t/min is scaled wrong.
export const SPARK_SCALE = 8000;

// updateSpark — push one tok/min sample onto agent.spark, normalized over
// the elapsed wall-clock since the previous sample. Mutates agent.spark,
// agent.lastTokSampleTs and agent.lastTokRate in place (agent may be a real
// Agent/PtyAgent instance or a plain object in tests). `now` is injected so
// tests are deterministic.
export function updateSpark(agent, deltaTokens, now = Date.now()) {
  // `?? now` (not `|| now`): lastTokSampleTs of 0 is a valid epoch
  // timestamp, not "missing" — `||` would treat it as missing and zero the
  // elapsed window, spiking the first sample.
  const last = agent.lastTokSampleTs ?? now;
  const dt = Math.max(0.05, (now - last) / 1000);
  const ratePerMin = (deltaTokens / dt) * 60;
  const arr = Array.isArray(agent.spark) ? agent.spark : Array(SPARK_LEN).fill(1);
  agent.spark = [...arr.slice(1), Math.max(0.5, ratePerMin / SPARK_SCALE)];
  agent.lastTokSampleTs = now;
  agent.lastTokRate = ratePerMin;
}
