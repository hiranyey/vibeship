import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const brand = (file: string) => new URL(`../../brand/${file}`, import.meta.url);

export const STATIC: Record<string, { file: URL; type: string }> = {
  'vibeship.css': { file: new URL('../../vibeship.css', import.meta.url), type: 'text/css; charset=utf-8' },
  'ui.js': { file: new URL('./static/ui.js', import.meta.url), type: 'text/javascript; charset=utf-8' },
  'vibeship-mark.svg': { file: brand('vibeship-mark.svg'), type: 'image/svg+xml' },
};

export type Loaded = { body: Buffer; type: string; mtimeMs: number; version: string };
const loaded = new Map<string, Loaded>();

/**
 * A static file, read again whenever it changes on disk. In development
 * vibeship.css is bind-mounted from outside src/, so node --watch does not
 * restart for it; checking the mtime keeps it current without a restart.
 */
export function readAsset(name: string, files: Record<string, { file: URL; type: string }>): Loaded | undefined {
  const entry = files[name];
  if (!entry) return undefined;
  const key = entry.file.href;
  const mtimeMs = statSync(entry.file).mtimeMs;
  const cached = loaded.get(key);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const body = readFileSync(entry.file);
  const asset = { body, type: entry.type, mtimeMs, version: createHash('sha256').update(body).digest('hex').slice(0, 10) };
  loaded.set(key, asset);
  return asset;
}

/** `/static/<name>?v=<hash of its content>`, so a changed file is a new URL and never a stale cache hit. */
export function assetUrl(name: 'vibeship.css' | 'ui.js'): string {
  return `/static/${name}?v=${readAsset(name, STATIC)!.version}`;
}

