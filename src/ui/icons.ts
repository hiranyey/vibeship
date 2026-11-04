import { raw } from 'hono/html';

/** 16×16 stroke icons that take the surrounding text colour. Decorative: always pair with a label or aria-label. */
const PATHS = {
  projects: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  registries: '<path d="M8 1.8l5.7 3.1v6.2L8 14.2l-5.7-3.1V4.9z"/><path d="M2.5 5L8 8l5.5-3M8 8v6"/>',
  tokens: '<circle cx="5.5" cy="8" r="3"/><path d="M8.5 8h6M12.5 8v2.5M14.5 8v1.8"/>',
  audit: '<path d="M4 1.8h5.5L13 5.3v8.9H4z"/><path d="M9.5 1.8v3.5H13M6 8.5h4.5M6 11h4.5"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  logout: '<path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3"/><path d="M10.5 5L13.5 8l-3 3M13.5 8H6"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  rocket: '<path d="M9.5 2.2c2.4-.6 4.3-.4 4.3-.4s.2 1.9-.4 4.3c-.6 2.3-2.6 4.4-4.9 5.6L6.3 9.5 4.1 7.3C5.3 5 7.2 2.8 9.5 2.2z"/><path d="M6.3 9.5L4 11.8M4.1 7.3l-2 .4 1.4-2.4 2.4-.3M8.7 11.7l-.4 2 2.4-1.4.3-2.4"/><circle cx="10.5" cy="5.5" r="1"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/>',
  mcp: '<path d="M6 2v3M10 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16) {
  return raw(
    `<svg class="icon" viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`,
  );
}
