const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const TAG_RE = /<timestamp>\s*([\s\S]*?)\s*<\/timestamp>/i;
const CURSOR_TS_RE =
  /^(\w+),\s+(\w+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(([^)]+)\)$/i;

function parseOffsetMinutes(label: string): number | null {
  const m = label.trim().match(/^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const mins = m[3] ? Number(m[3]) : 0;
  return sign * (hours * 60 + mins);
}

/** Parse Cursor's human timestamp tag into epoch ms. */
export function parseCursorTimestamp(raw: string): number | null {
  const text = raw.trim();
  const isoTry = Date.parse(text);
  if (!Number.isNaN(isoTry)) return isoTry;

  const m = text.match(CURSOR_TS_RE);
  if (!m) return null;

  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;

  let hour = Number(m[5]);
  const minute = Number(m[6]);
  const ampm = m[7].toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  const offset = parseOffsetMinutes(m[8]);
  if (offset === null) return null;

  const utcMs = Date.UTC(Number(m[4]), month, Number(m[3]), hour, minute, 0, 0);
  return utcMs - offset * 60_000;
}

export function extractTimestampTag(text: string): number | null {
  const m = text.match(TAG_RE);
  if (!m) return null;
  return parseCursorTimestamp(m[1]);
}

export class TimestampCursor {
  private currentMs: number;

  constructor(anchorMs: number) {
    this.currentMs = anchorMs;
  }

  next(explicitMs: number | null): string {
    if (explicitMs !== null) {
      this.currentMs = explicitMs;
    } else {
      this.currentMs += 1;
    }
    return new Date(this.currentMs).toISOString();
  }
}
