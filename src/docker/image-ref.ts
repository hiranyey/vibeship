export type ImageRef = {
  /** Registry host as written, e.g. `localhost:5050` or `repoflow.hiranyey.dev`; null for Docker Hub. */
  host: string | null;
  /** Everything before the tag, e.g. `localhost:5050/library/hello`. */
  repository: string;
  tag: string;
};

/** Splits an image reference like `host:5050/library/app:tag` (digests are not accepted here). */
export function parseImageRef(ref: string): ImageRef {
  if (ref.includes('@')) throw new Error(`Image reference must not include a digest: ${ref}`);
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  const hasTag = colon > slash;
  const repository = hasTag ? ref.slice(0, colon) : ref;
  const tag = hasTag ? ref.slice(colon + 1) : 'latest';

  // Same rule Docker uses: the first part is a registry host only if it looks like one.
  const first = repository.split('/')[0]!;
  const isHost = repository.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  return { host: isHost ? first : null, repository, tag };
}

/** The reference that pins an exact image: `<repository>@<digest>`. */
export function pinned(ref: ImageRef | string, digest: string): string {
  const repository = typeof ref === 'string' ? parseImageRef(ref).repository : ref.repository;
  return `${repository}@${digest}`;
}
