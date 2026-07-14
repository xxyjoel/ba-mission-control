// tests/spark.test.mjs — the shared tok/min normalizer (#26).
// Verifies the rate math both pipelines now share, and the SPARK_SCALE
// round-trip the UI relies on to denormalize back to tokens/min.

import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSpark, SPARK_LEN, SPARK_SCALE } from '../server/spark.mjs';

test('updateSpark: 8000 tok over 60s → normalized 1.0, keeps array length', () => {
  const a = { spark: Array(SPARK_LEN).fill(1), lastTokSampleTs: 1000, lastTokRate: 0 };
  updateSpark(a, 8000, 1000 + 60_000); // 8000 tok / 60s = 8000/min
  assert.equal(a.spark.length, SPARK_LEN);
  assert.ok(Math.abs(a.spark.at(-1) - 1) < 1e-9, 'ratePerMin/SPARK_SCALE = 8000/8000 = 1');
  assert.ok(Math.abs(a.lastTokRate - 8000) < 1e-6); // (8000/60)*60 has float drift
  assert.equal(a.lastTokSampleTs, 61_000);
});

test('updateSpark: double the throughput → double the normalized sample', () => {
  const a = { spark: Array(SPARK_LEN).fill(1), lastTokSampleTs: 0 };
  updateSpark(a, 16_000, 60_000); // 16000/min
  assert.ok(Math.abs(a.spark.at(-1) - 2) < 1e-9);
});

test('updateSpark: zero throughput floors at 0.5 (so idle still draws a glyph)', () => {
  const a = { spark: Array(SPARK_LEN).fill(1), lastTokSampleTs: 0 };
  updateSpark(a, 0, 60_000);
  assert.equal(a.spark.at(-1), 0.5);
});

test('updateSpark: tolerates a bare agent (no spark / no lastTokSampleTs)', () => {
  const a = {};
  updateSpark(a, 1000, 1000);
  assert.equal(a.spark.length, SPARK_LEN);
  assert.ok(a.lastTokRate >= 0);
});

test('SPARK_SCALE round-trips: normalized × SPARK_SCALE recovers tokens/min', () => {
  const a = { lastTokSampleTs: 0 };
  updateSpark(a, 4000, 60_000); // 4000/min
  assert.ok(Math.abs(a.spark.at(-1) * SPARK_SCALE - 4000) < 1e-6);
});
