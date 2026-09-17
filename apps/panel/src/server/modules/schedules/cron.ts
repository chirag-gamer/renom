/**
 * Minimal cron parser: standard 5-field (minute hour dom month dow, UTC).
 * Supports `*`, `*\/n`, ranges (`a-b`), steps on ranges (`a-b/n`), and lists.
 * Named months/days are NOT supported — numbers only, rejected loudly.
 */

export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
}

const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new CronError("Cron needs exactly 5 fields (minute hour day month weekday)");
  const [minute, hour, dom, month, dow] = parts.map((p, i) =>
    parseField(p, RANGES[i]![0], RANGES[i]![1], i),
  );
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow! };
}

/** Next run strictly after `fromMs` (UTC), scanning forward at most ~366 days. */
export function nextRun(fields: CronFields, fromMs: number): number {
  // Start at the next whole minute.
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const limit = fromMs + 366 * 24 * 3_600_000;
  while (t <= limit) {
    const d = new Date(t);
    if (
      fields.minute.includes(d.getUTCMinutes()) &&
      fields.hour.includes(d.getUTCHours()) &&
      fields.month.includes(d.getUTCMonth() + 1) &&
      dayMatches(fields, d)
    ) {
      return t;
    }
    t += 60_000;
  }
  throw new CronError("No run found within a year — check the expression");
}

// Cron day semantics: dom OR dow (either matching day fires), unless one side is '*'.
function dayMatches(fields: CronFields, d: Date): boolean {
  const domWild = fields.dom.length === 31;
  const dowWild = fields.dow.length === 7;
  const domHit = fields.dom.includes(d.getUTCDate());
  const dowHit = fields.dow.includes(d.getUTCDay());
  if (domWild && dowWild) return true;
  if (domWild) return dowHit;
  if (dowWild) return domHit;
  return domHit || dowHit;
}

function parseField(raw: string, min: number, max: number, index: number): number[] {
  const out = new Set<number>();
  const chunks = raw.split(",");
  if (chunks.length === 0 || raw === "") throw new CronError(`Field ${index + 1} is empty`);
  for (const chunk of chunks) {
    const [rangePart, stepPart] = chunk.split("/");
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      throw new CronError(`Bad step '${stepPart}' in field ${index + 1}`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (step < 1) throw new CronError(`Step must be >= 1 in field ${index + 1}`);
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      [lo, hi] = [min, max];
    } else if (rangePart !== undefined && rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a === undefined || b === undefined) {
        throw new CronError(`Bad range '${rangePart}' in field ${index + 1}`);
      }
      [lo, hi] = [a, b];
    } else {
      const v = Number(rangePart);
      if (!Number.isInteger(v))
        throw new CronError(`Bad value '${rangePart}' in field ${index + 1}`);
      // `5` means exactly 5; `5/15` means 5..max stepping 15.
      [lo, hi] = stepPart === undefined ? [v, v] : [v, max];
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronError(`Value out of range ${min}-${max} in field ${index + 1}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new CronError(`Field ${index + 1} matches nothing`);
  return [...out].sort((a, b) => a - b);
}

export class CronError extends Error {}
