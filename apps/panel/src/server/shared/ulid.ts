/**
 * Minimal ULID generator (monotonic within process).
 * 48-bit millisecond timestamp + 80 bits of randomness, Crockford Base32, 26 chars.
 * Used for primary keys across the schema (DATA-MODEL.md conventions).
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" as const;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ENCODING[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function randomBits(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes);
}

function encodeRandom(bits: number[]): string {
  let out = "";
  // 80 bits -> 16 chars of 5 bits
  let acc = 0;
  let accBits = 0;
  for (const byte of bits) {
    acc = (acc << 8) | byte;
    accBits += 8;
    while (accBits >= 5) {
      out += ENCODING[(acc >>> (accBits - 5)) & 31];
      accBits -= 5;
    }
  }
  if (accBits > 0) {
    out += ENCODING[(acc << (5 - accBits)) & 31];
  }
  return out;
}

/** crypto global is available in Node >= 19 without import. */
declare const crypto: { getRandomValues(t: Uint8Array): Uint8Array };

/** Generate a ULID; monotonic when called repeatedly inside the same millisecond. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // increment last random value for strict monotonicity
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      const idx = lastRandom[i]! + 1;
      if (idx <= 255) {
        lastRandom[i] = idx;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = randomBits();
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}
