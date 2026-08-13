import { randomBytes, createHmac } from "crypto";

// Time-based One-Time Password (RFC 6238), built on HMAC-based One-Time
// Password (RFC 4226) — the standard behind Google Authenticator, Authy,
// 1Password, etc. Implemented directly on Node's built-in `crypto` rather
// than pulling in a library: TOTP is a small, fully-specified algorithm
// (a handful of well-defined steps), and avoiding a new dependency here
// sidesteps the exact "forgot to add it to package.json, npm install
// required before build" trap that came up with the charting library
// earlier in this session.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30; // standard TOTP time step
const CODE_DIGITS = 6;
const WINDOW = 1; // accept codes from 1 step before/after to tolerate clock drift

function base32Encode(buffer: Buffer): string {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder > 0) {
    const lastChunk = bits.slice(bits.length - remainder).padEnd(5, "0");
    output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Generates a new random 160-bit secret, base32-encoded for QR/manual entry. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer per RFC 4226. Node's Buffer has
  // no writeUInt64BE, so split across two 32-bit writes.
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter % 2 ** 32, 4);

  const hmac = createHmac("sha1", secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binCode % 10 ** CODE_DIGITS).toString().padStart(CODE_DIGITS, "0");
}

/** Generates the current 6-digit code for a base32 secret — mainly useful for tests. */
export function generateTotpCode(base32Secret: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / STEP_SECONDS);
  return hotp(base32Decode(base32Secret), counter);
}

/**
 * Verifies a user-entered code against a secret, tolerating clock drift by
 * checking a small window of adjacent time steps (current step ± WINDOW).
 */
export function verifyTotpCode(base32Secret: string, code: string, at: number = Date.now()): boolean {
  const cleanCode = (code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleanCode)) return false;

  const secret = base32Decode(base32Secret);
  const currentCounter = Math.floor(at / 1000 / STEP_SECONDS);

  for (let errorWindow = -WINDOW; errorWindow <= WINDOW; errorWindow++) {
    if (hotp(secret, currentCounter + errorWindow) === cleanCode) return true;
  }
  return false;
}

/**
 * Builds an otpauth:// URI for QR-code enrollment — the standard format
 * every major authenticator app recognizes when scanned.
 */
export function buildOtpauthUri(secret: string, accountLabel: string, issuer: string): string {
  const encodedLabel = encodeURIComponent(`${issuer}:${accountLabel}`);
  const encodedIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${CODE_DIGITS}&period=${STEP_SECONDS}`;
}

/** Generates a set of one-time-use recovery codes for when a user loses their authenticator device. */
export function generateRecoveryCodes(count: number = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}
