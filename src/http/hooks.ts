import { Hono } from 'hono';
import { z } from 'zod';
import { systemContext } from '../actor.ts';
import { parseImageRef } from '../docker/image-ref.ts';
import { AppError } from '../errors.ts';
import { Digest } from '../schemas.ts';
import type { Services } from '../services/index.ts';
import { parseInput } from '../services/validate.ts';
import type { AppEnv } from './auth.ts';

export const WebhookInput = z.object({
  digest: Digest,
  /**
   * Optional: the image the CI pushed, e.g. `registry/library/app` or
   * `registry/library/app:main`. If given, it must be the project's repository.
   */
  image: z.string().max(255).optional(),
});

/**
 * `POST /hooks/deploy/:token`, called by CI after pushing an image. The token
 * names the project, so the body carries only the digest. The deploy pulls
 * `<project repository>@<digest>`, so a digest from another repository fails
 * at the pull and never replaces the running version.
 */
export function hookRoutes(deps: { services: Services }): Hono<AppEnv> {
  const s = deps.services;
  const app = new Hono<AppEnv>();

  app.post('/deploy/:token', async (c) => {
    const project = s.projects.findByWebhookToken(c.req.param('token'));
    // The same answer for unknown and rotated tokens, so neither can be probed.
    if (!project?.image) throw new AppError('not_found', 'Unknown webhook');

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError('validation', 'Send JSON like {"digest": "sha256:…"}');
    }
    const input = parseInput(WebhookInput, raw);
    if (input.image !== undefined) {
      const sent = input.image.includes('@') ? input.image.slice(0, input.image.indexOf('@')) : input.image;
      let repository: string | null = null;
      try {
        repository = parseImageRef(sent).repository;
      } catch {
        // Falls through to the mismatch error.
      }
      if (repository !== parseImageRef(project.image.imageRef).repository) {
        throw new AppError('validation', `image: this webhook deploys ${parseImageRef(project.image.imageRef).repository}, not ${sent}`);
      }
    }

    const ctx = { ...systemContext, ip: c.get('ip') };
    const d = s.deploys.request(ctx, project.id, { digest: input.digest }, 'webhook');
    return c.json({ deploy: { id: d.id, status: d.status, digest: d.digest } }, 202);
  });

  return app;
}
