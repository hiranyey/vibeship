import type { z } from 'zod';
import { AppError } from '../errors.ts';

/** Parses service input, turning Zod issues into a `validation` AppError. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({
    path: i.path.join('.'),
    // A bad record key (e.g. an env var name) carries the real reason one level down.
    message: i.code === 'invalid_key' && i.issues.length > 0 ? i.issues.map((x) => x.message).join('; ') : i.message,
  }));
  const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
  throw new AppError('validation', summary, { issues });
}
