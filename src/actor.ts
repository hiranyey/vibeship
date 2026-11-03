/** Who is making a change: the logged-in user, an API token, or Vibeship itself. */
export type Actor =
  | { type: 'user'; userId: number }
  | { type: 'token'; tokenId: number }
  | { type: 'system' };

/** Passed to every service call that changes something, so it can be audited. */
export type RequestContext = {
  actor: Actor;
  ip?: string | null;
};

export const systemContext: RequestContext = { actor: { type: 'system' } };

/** The form stored in `created_by`, `updated_by` and `actor` columns. */
export function actorLabel(actor: Actor): string {
  switch (actor.type) {
    case 'user':
      return `user:${actor.userId}`;
    case 'token':
      return `token:${actor.tokenId}`;
    case 'system':
      return 'system';
  }
}
