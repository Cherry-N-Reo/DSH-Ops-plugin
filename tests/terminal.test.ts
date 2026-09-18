import test from "node:test";
import assert from "node:assert/strict";
import { calibrate, calibrationValid, collect, extract, markers, stitch } from "../src/terminal.ts";

const calibration = { viewport: { screenWidth: 1, screenHeight: 1, terminalWidth: 1, terminalHeight: 1, lineHeight: 1, zoom: 1, dpi: 1 }, fullPageTicks: 10, collectionTicks: 4, overlapRatio: .18 };

test("calibrates from the median and validates viewport drift", () => {
  const viewport = { screenWidth: 100, screenHeight: 100, terminalWidth: 80, terminalHeight: 24, lineHeight: 1, zoom: 1, dpi: 96 };
  const result = calibrate(viewport, [{ ticks: 100, movementRatio: 1 }, { ticks: 120, movementRatio: 1 }, { ticks: 110, movementRatio: 1 }]);
  assert.equal(result.fullPageTicks, 110);
  assert.equal(result.collectionTicks, 90);
  assert.equal(calibrationValid(viewport, { ...viewport, terminalHeight: 26 }), true);
  assert.equal(calibrationValid(viewport, { ...viewport, terminalHeight: 30 }), false);
  assert.throws(() => calibrate(viewport, [{ ticks: 1, movementRatio: 1 }]));
});

test("stitches one exact overlap and rejects repeated overlap candidates", () => {
  assert.deepEqual(stitch("a\nb\nc", "b\nc\nd"), { text: "a\nb\nc\nd", overlapLines: 2, ratio: 2 / 3, continuous: true });
  assert.equal(stitch("x\nx", "x\nx").continuous, false);
});

test("uses an END rc record and emits a one-line wrapper", () => {
  const wrapped = markers("printf '%s' 'a b'; false", "id/'quoted");
  assert.equal(wrapped.wrapped.includes("\n"), false);
  assert.throws(() => markers("head -c 1\n", "bad"));
  assert.deepEqual(extract(`noise\n${wrapped.begin}\na b\n${wrapped.end} rc=1\n`, wrapped.begin, wrapped.end), { output: "a b", exitCode: 1, complete: true });
  assert.equal(extract(`${wrapped.begin}\nx\n${wrapped.end} rc=1 trailing`, wrapped.begin, wrapped.end).complete, false);
  assert.equal(extract(`${wrapped.begin}\n${wrapped.begin}\nx\n${wrapped.end} rc=0`, wrapped.begin, wrapped.end).complete, false);
});

test("collects three pages with an exact scroll budget and restores the net offset", async () => {
  const scrolls: number[] = [];
  const captures = ["B\nC\n__DSH_END_x__ rc=0", "A\nB\nC", "__DSH_BEGIN_x__\nZ\nA"];
  const driver = { capture: async () => captures.shift()!, scroll: async (ticks: number) => { scrolls.push(ticks); } };
  const result = await collect(driver, { begin: "__DSH_BEGIN_x__", end: "__DSH_END_x__" }, calibration, 3);
  assert.deepEqual(result, { output: "Z\nA\nB\nC", exitCode: 0, complete: true, truncated: false, reason: "complete", screens: 3 });
  assert.deepEqual(scrolls, [4, 5, -9]);
});

test("reports a continuity gap even when recovery can capture a complete-looking record", async () => {
  const scrolls: number[] = [];
  const captures = ["C\n__DSH_END_x__ rc=0", "unrelated", "still unrelated", "unrelated again"];
  const driver = { capture: async () => captures.shift()!, scroll: async (ticks: number) => { scrolls.push(ticks); } };
  const result = await collect(driver, { begin: "__DSH_BEGIN_x__", end: "__DSH_END_x__" }, calibration, 4);
  assert.equal(result.complete, false);
  assert.equal(result.reason, "continuity gap");
  assert.equal(result.output, "C\n__DSH_END_x__ rc=0");
  assert.deepEqual(scrolls, [4, -2, -1, -1]);
});

test("does not scroll a single-screen command or a command without END", async () => {
  const firstScrolls: number[] = [];
  const complete = await collect({ capture: async () => "__DSH_BEGIN_x__\nready\n__DSH_END_x__ rc=0", scroll: async (ticks: number) => { firstScrolls.push(ticks); } }, { begin: "__DSH_BEGIN_x__", end: "__DSH_END_x__" }, calibration, 5);
  assert.equal(complete.complete, true);
  assert.deepEqual(firstScrolls, []);
  const secondScrolls: number[] = [];
  const running = await collect({ capture: async () => "still running", scroll: async (ticks: number) => { secondScrolls.push(ticks); } }, { begin: "BEGIN", end: "END" }, calibration, 5);
  assert.equal(running.reason, "command still running");
  assert.deepEqual(secondScrolls, []);
});
