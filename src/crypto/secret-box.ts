import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { MASTER_KEY_BYTES } from './master-key.ts';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM encryption for values stored in the database.
 *
 * Sealed values look like `v1:<iv>:<ciphertext>:<tag>` in base64url. The
 * `context` string is bound in as additional data, so a value sealed for one
 * row (e.g. `env:3:DATABASE_URL`) fails to open if copied into another.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== MASTER_KEY_BYTES) throw new Error(`SecretBox key must be ${MASTER_KEY_BYTES} bytes`);
    this.#key = key;
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv, ciphertext, cipher.getAuthTag()]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join(':');
  }

  open(sealed: string, context: string): string {
    const parts = sealed.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Malformed sealed value');
    const [iv, ciphertext, tag] = parts.slice(1).map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv('aes-256-gcm', this.#key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Could not decrypt value: wrong key, wrong context or tampered data');
    }
  }
}
