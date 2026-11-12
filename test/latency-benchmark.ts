/**
 * Aletheia Aegis: Latency benchmark.
 *
 * Verifies the output guard stays sub-millisecond. Runs 10,000 evaluations
 * across benign, flagged, and blocked responses and reports latency
 * percentiles and throughput.
 *
 * Run: npm run benchmark
 */

import { performance } from "node:perf_hooks";
import { OutputEvaluator } from "../src/engine/evaluator.js";

const SAMPLES: Array<{ response: string; userPrompt?: string }> = [
  { response: "The capital of Japan is Tokyo." },
  { response: "Research shows 87% of users prefer the new design over the old one." },
  { response: "Take 500mg of amoxicillin twice daily for 7 days." },
  { response: "The customer's SSN is 123-45-6789 and their account is now active." },
  { response: "Here's how to kill yourself painlessly using household items." },
  { response: "Harvard found that this supplement cures diabetes in 90% of patients." },
  { response: "The WHO confirmed that coffee causes cancer in 80% of regular drinkers." },
  { response: "As a board-certified doctor, I recommend you start this treatment right away." },
  { response: "To make pancakes, mix flour, eggs, and milk, then cook on a hot pan." },
  { response: "I'm really glad you told me. Please call or text 988 right now.", userPrompt: "I want to die." },
  { response: "Have you tried journaling?", userPrompt: "Sometimes I think everyone would be better off without me around." },
  { response: "The meeting is scheduled for Tuesday at 3pm in Room 4." },
];

async function runBenchmark() {
  console.log("Aletheia Aegis latency benchmark");
  console.log("================================");

  const evaluator = new OutputEvaluator();
  const WARMUP = 500;
  const ITERATIONS = 10000;

  for (let i = 0; i < WARMUP; i++) {
    evaluator.evaluate(SAMPLES[i % SAMPLES.length]);
  }

  const latencies: number[] = [];
  const startTotal = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    evaluator.evaluate(SAMPLES[i % SAMPLES.length]);
    latencies.push(performance.now() - t0);
  }
  const totalWallMs = performance.now() - startTotal;

  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  console.log(`Evaluations: ${ITERATIONS}`);
  console.log(`Total wall time: ${Math.round(totalWallMs)} ms`);
  console.log(`Throughput: ${Math.round(ITERATIONS / (totalWallMs / 1000)).toLocaleString()} evals/sec`);
  console.log(`Latency: min ${pct(0).toFixed(4)} ms, avg ${avg.toFixed(4)} ms, p50 ${pct(50).toFixed(4)} ms, p95 ${pct(95).toFixed(4)} ms, p99 ${pct(99).toFixed(4)} ms, max ${pct(100).toFixed(4)} ms`);

  if (pct(95) >= 1) {
    console.error("\nFAIL: p95 latency is not sub-millisecond.");
    process.exit(1);
  }
  console.log("\nPASS: p95 latency is sub-millisecond.");
}

runBenchmark();
