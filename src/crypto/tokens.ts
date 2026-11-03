import { createHash, randomBytes } from 'node:crypto';

/** A random token in base64url, used for sessions, API tokens and webhook URLs. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex digest. Tokens are stored only as this hash and looked up by it. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
