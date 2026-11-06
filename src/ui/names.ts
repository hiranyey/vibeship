import { html } from 'hono/html';
import type { Services } from '../services/index.ts';
import type { Html } from './components.ts';

export type Names = ReturnType<typeof names>;

/**
 * Turns stored references (`user:1`, `token:2`, `project:3`, `deploy:10`,
 * `system`) into what people recognise: an email, a token or project name,
 * linked where a page exists. The raw reference stays in the tooltip.
 * Each one is looked up once per page.
 */
export function names(s: Services) {
  const memo = <T>(fn: (id: number) => T) => {
    const seen = new Map<number, T>();
    return (id: number): T => {
      if (!seen.has(id)) seen.set(id, fn(id));
      return seen.get(id)!;
    };
  };
  const safe = <T>(fn: () => T): T | null => {
    try {
      return fn();
    } catch {
      return null; // deleted since
    }
  };
  const userEmail = memo((id) => s.sessions.getUser(id)?.email ?? null);
  const tokenName = memo((id) => safe(() => s.tokens.get(id).name));
  const projectName = memo((id) => safe(() => s.projects.get(id).name));
  const registryName = memo((id) => safe(() => s.registries.get(id).name));
  const projectExists = new Map<string, boolean>();

  /** A project named in audit details: linked while it exists, plain once deleted. */
  function projectLink(name: string): Html {
    if (!name) return html``;
    if (!projectExists.has(name)) projectExists.set(name, safe(() => s.projects.getByName(name)) !== null);
    return projectExists.get(name) ? html`<a href="/projects/${name}"><strong>${name}</strong></a>` : html`<strong>${name}</strong>`;
  }

  const user = (id: number, ref: string): Html => html`<span title="${ref}">${userEmail(id) ?? 'a deleted user'}</span>`;
  const token = (id: number, ref: string): Html => {
    const name = tokenName(id);
    return name ? html`<a href="/tokens#token-${id}" title="${ref}">${name}</a>` : html`<span title="${ref}">a deleted token</span>`;
  };
  const system = (trigger?: string): Html => html`<span class="text-muted">${trigger === 'webhook' ? 'System (webhook)' : 'System'}</span>`;

  /** Who did something, from an `actor`, `created_by` or `updated_by` value. */
  function actor(ref: string | null | undefined, opts: { trigger?: string } = {}): Html {
    const m = /^(user|token):(\d+)$/.exec(ref ?? '');
    if (m?.[1] === 'user') return user(Number(m[2]), ref!);
    if (m?.[1] === 'token') return token(Number(m[2]), ref!);
    if (ref === 'system' || !ref) return system(opts.trigger);
    return html`${ref}`;
  }

  /** What something was done to, from an audit `target`; `fallback` names it if it has since been deleted. */
  function target(ref: string | null, fallback?: string): Html {
    const m = /^([a-z]+):(.+)$/.exec(ref ?? '');
    if (!m) return html``;
    const [, kind, key] = m as unknown as [string, string, string];
    const id = Number(key);
    switch (kind) {
      case 'project': {
        const name = projectName(id);
        return name ? html`<a href="/projects/${name}" title="${ref}"><strong>${name}</strong></a>` : html`<strong title="${ref}">${fallback ?? ref}</strong>`;
      }
      case 'token': {
        const name = tokenName(id);
        return name ? html`<a href="/tokens#token-${id}" title="${ref}"><strong>${name}</strong></a>` : html`<strong title="${ref}">${fallback ?? ref}</strong>`;
      }
      case 'registry': {
        const name = registryName(id);
        return name ? html`<a href="/registries/${id}" title="${ref}"><strong>${name}</strong></a>` : html`<strong title="${ref}">${fallback ?? ref}</strong>`;
      }
      case 'deploy':
        return html`<a class="mono" href="/deploys/${id}" title="${ref}">#${id}</a>`;
      case 'user':
        return html`<strong title="${ref}">${userEmail(id) ?? fallback ?? ref}</strong>`;
      case 'setting':
        return html`<code class="inline">${key}</code>`;
      default:
        return html`<span class="mono">${ref}</span>`;
    }
  }

  return { actor, target, projectLink, userEmail, tokenName, projectName };
}
