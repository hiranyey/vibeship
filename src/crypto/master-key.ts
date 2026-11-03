import { randomBytes } from 'node:crypto';

export const MASTER_KEY_BYTES = 32;

/** A new key in the form `MASTER_KEY` expects: 32 random bytes in base64. */
export function generateMasterKey(): string {
  return randomBytes(MASTER_KEY_BYTES).toString('base64');
}

/** Decodes `MASTER_KEY`, returning null unless it is valid base64 for exactly 32 bytes. */
export function parseMasterKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const key = Buffer.from(trimmed, 'base64');
  return key.length === MASTER_KEY_BYTES ? key : null;
}

// `npm run gen-key` prints a key to paste into .env.
if (import.meta.main) console.log(generateMasterKey());
