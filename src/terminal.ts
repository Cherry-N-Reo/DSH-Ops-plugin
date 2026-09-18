/** Pure terminal calibration, stitching, marker, extraction, and bounded collection helpers. */

export type Viewport = { screenWidth: number; screenHeight: number; terminalWidth: number; terminalHeight: number; lineHeight: number; zoom: number; dpi: number };
export type Calibration = { viewport: Viewport; fullPageTicks: number; collectionTicks: number; overlapRatio: number };
export type CollectedTerminal = { output: string; exitCode: number | null; complete: boolean; truncated: boolean; reason: string; screens: number };
export type TerminalDriver = { capture(): Promise<string>; scroll(ticks: number): Promise<void> };

const EPSILON = 1e-9;
function finitePositive(value: number, name: string): void { if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`); }
function lines(value: string): string[] { return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"); }
function trimTerminalEnd(value: string): string { return value.replace(/\n$/, ""); }
function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function exitCodeFromLine(line: string, end: string): number | null {
  const prefix = `${end} rc=`;
  if (!line.startsWith(prefix)) return null;
  const suffix = line.slice(prefix.length);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(suffix)) return null;
  const exitCode = Number(suffix);
  return exitCode <= 255 ? exitCode : null;
}

/** Derive one full-page movement and one overlapped collection movement from samples. */
export function calibrate(viewport: Viewport, samples: { ticks: number; movementRatio: number }[], overlapRatio = 0.18): Calibration {
  for (const [name, value] of Object.entries(viewport)) finitePositive(value, name);
  if (!Number.isFinite(overlapRatio) || overlapRatio < 0 || overlapRatio >= 1) throw new RangeError("overlapRatio must be finite and in [0, 1)");
  if (samples.length === 0) throw new RangeError("at least one calibration sample is required");
  const estimates = samples.map(({ ticks, movementRatio }) => { finitePositive(ticks, "ticks"); finitePositive(movementRatio, "movementRatio"); return ticks / movementRatio; }).sort((a, b) => a - b);
  const middle = Math.floor(estimates.length / 2);
  const fullPageTicks = estimates.length % 2 === 0 ? (estimates[middle - 1] + estimates[middle]) / 2 : estimates[middle];
  const collectionTicks = Math.floor(fullPageTicks * (1 - overlapRatio));
  if (collectionTicks < 1 || collectionTicks >= fullPageTicks) throw new RangeError("calibration cannot represent a strictly smaller collection step");
  return { viewport, fullPageTicks, collectionTicks, overlapRatio };
}

/** Return whether two viewport readings are within a component-wise relative tolerance. */
export function calibrationValid(a: Viewport, b: Viewport, threshold = 0.15): boolean {
  if (!Number.isFinite(threshold) || threshold < 0) return false;
  return (Object.keys(a) as (keyof Viewport)[]).every((key) => { const left = a[key]; const right = b[key]; return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right), EPSILON) * threshold; });
}

/** Join adjacent captures only when their exact line overlap has one unambiguous length. */
export function stitch(older: string, newer: string): { text: string; overlapLines: number; ratio: number; continuous: boolean } {
  const oldLines = lines(older); const newLines = lines(newer); const candidates: number[] = [];
  for (let count = 1; count <= Math.min(oldLines.length, newLines.length); count++) if (oldLines.slice(-count).every((line, index) => line === newLines[index])) candidates.push(count);
  if (candidates.length !== 1) return { text: trimTerminalEnd(`${older}\n${newer}`), overlapLines: 0, ratio: 0, continuous: false };
  const overlapLines = candidates[0];
  return { text: trimTerminalEnd([...oldLines, ...newLines.slice(overlapLines)].join("\n")), overlapLines, ratio: overlapLines / Math.max(1, newLines.length), continuous: true };
}

/** Wrap a POSIX command on one physical line with a unique marker record. */
export function markers(command: string, id: string): { wrapped: string; begin: string; end: string } {
  if (/[\u0000-\u001f\u007f]/.test(command)) throw new RangeError("command must be a single-line POSIX command");
  const tag = id.replace(/[^A-Za-z0-9_.-]/g, "_") || "command";
  const begin = `__DSH_BEGIN_${tag}__`; const end = `__DSH_END_${tag}__`;
  const wrapped = `printf '\\n%s\\n' ${shellQuote(begin)}; ( ${command} ); __dsh_rc=$?; printf '\\n%s rc=%s\\n' ${shellQuote(end)} "$__dsh_rc"`;
  return { wrapped, begin, end };
}

/** Extract one complete marker record; malformed or repeated records remain incomplete. */
export function extract(text: string, begin: string, end: string): { output: string; exitCode: number | null; complete: boolean } {
  const recordLines = lines(text);
  const begins = recordLines.flatMap((line, index) => line === begin ? [index] : []);
  const ends = recordLines.flatMap((line, index) => exitCodeFromLine(line, end) === null ? [] : [index]);
  if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) return { output: "", exitCode: null, complete: false };
  const exitCode = exitCodeFromLine(recordLines[ends[0]], end);
  if (exitCode === null) return { output: "", exitCode: null, complete: false };
  return { output: trimTerminalEnd(recordLines.slice(begins[0] + 1, ends[0]).join("\n")), exitCode, complete: Number.isSafeInteger(exitCode) };
}

/** Collect at most `maxScreens` captures and restore only the upward distance actually scrolled. */
export async function collect(driver: TerminalDriver, marker: { begin: string; end: string }, calibration: Calibration, maxScreens: number): Promise<CollectedTerminal> {
  if (!Number.isInteger(maxScreens) || maxScreens < 1) throw new RangeError("maxScreens must be a positive integer");
  finitePositive(calibration.fullPageTicks, "fullPageTicks"); finitePositive(calibration.collectionTicks, "collectionTicks");
  if (!Number.isInteger(calibration.collectionTicks) || calibration.collectionTicks >= calibration.fullPageTicks) throw new RangeError("collectionTicks must be an integer strictly below fullPageTicks");
  let screens = 0; let scrolledUp = 0; let step = calibration.collectionTicks;
  const maximumStep = Math.floor(calibration.fullPageTicks);
  try {
    const initial = await driver.capture(); screens = 1;
    const initialResult = extract(initial, marker.begin, marker.end);
    if (initialResult.complete) return { ...initialResult, truncated: false, reason: "complete", screens };
    if (!lines(initial).some((line) => exitCodeFromLine(line, marker.end) !== null)) return { output: initial, exitCode: null, complete: false, truncated: false, reason: "command still running", screens };
    let assembled = initial; let newerCapture = initial; let continuityGap = false;
    while (screens < maxScreens) {
      await driver.scroll(step); scrolledUp += step;
      const older = await driver.capture(); screens++;
      const immediate = stitch(older, newerCapture);
      const stitched = stitch(older, assembled);
      if (!stitched.continuous || stitched.overlapLines === 0) {
        continuityGap = true;
        for (const recoveryTicks of [2, 1]) {
          if (screens >= maxScreens) break;
          await driver.scroll(-recoveryTicks); scrolledUp -= recoveryTicks;
          const recovered = await driver.capture(); screens++;
          const recoveredStitch = stitch(recovered, assembled);
          if (recoveredStitch.continuous && recoveredStitch.overlapLines > 0) {
            assembled = recoveredStitch.text;
            newerCapture = recovered;
            continuityGap = false;
            const recoveredResult = extract(assembled, marker.begin, marker.end);
            if (recoveredResult.complete) return { ...recoveredResult, truncated: false, reason: "complete", screens };
            break;
          }
        }
        if (continuityGap) break;
      } else {
        assembled = stitched.text;
        newerCapture = older;
        const ratio = immediate.continuous ? immediate.ratio : stitched.ratio;
        if (ratio > 0.25 && step + 1 < maximumStep) step++;
        if (ratio < 0.10 && step > 1) step--;
        const result = extract(assembled, marker.begin, marker.end);
        if (result.complete) return { ...result, truncated: false, reason: "complete", screens };
      }
      if (!stitched.continuous && continuityGap) {
        const result = extract(assembled, marker.begin, marker.end);
        if (result.complete) return { output: assembled, exitCode: null, complete: false, truncated: false, reason: "continuity gap", screens };
      }
    }
    return { output: assembled, exitCode: null, complete: false, truncated: !continuityGap && screens >= maxScreens, reason: continuityGap ? "continuity gap" : "screen limit reached", screens };
  } finally {
    const restoreTicks = Math.round(scrolledUp);
    if (restoreTicks > 0) await driver.scroll(-restoreTicks);
  }
}
