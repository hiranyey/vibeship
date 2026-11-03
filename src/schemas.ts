import { z } from 'zod';

// Input schemas shared by the HTTP API and the MCP tools.

/**
 * Names that would shadow a container or network alias Vibeship relies on,
 * since every project's routed container joins `web` as `<project>`.
 */
export const RESERVED_NAMES = ['caddy', 'caddy-api', 'caddy-admin', 'vibeship', 'web', 'localhost'] as const;

/** A DNS label that also works as a compose project name and folder name. */
const dnsLabel = z
  .string()
  .regex(/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'use 1-32 lowercase letters, digits and hyphens, starting with a letter');

export const ProjectName = dnsLabel.refine(
  (n) => !(RESERVED_NAMES as readonly string[]).includes(n),
  { message: `is reserved (${RESERVED_NAMES.join(', ')})` },
);

export const Hostname = z.string().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/, 'must be a hostname');

const Port = z.number().int().min(1).max(65535);

export const ImageRef = z
  .string()
  .max(255)
  .regex(/^[a-z0-9][A-Za-z0-9._/:-]*$/, 'must be an image reference like registry/library/app:tag, without a digest');

export const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/, 'must be sha256:<64 hex characters>');

const HealthPath = z.string().max(255).regex(/^\/\S*$/, 'must start with /');
const MemLimit = z.string().regex(/^\d+[kmg]?$/i, 'must look like 512m or 1g');

export const ImageSourceFields = z.object({
  imageRef: ImageRef,
  containerPort: Port,
  registryId: z.number().int().positive().nullable().optional(),
  healthPath: HealthPath.nullable().optional(),
  memLimit: MemLimit.nullable().optional(),
});

export const ComposeVersionFields = z.object({
  composeYaml: z.string().min(1).max(256 * 1024),
  routedService: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'must be a compose service name'),
  port: Port,
  note: z.string().max(500).nullable().optional(),
});

export const CreateProjectInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), name: ProjectName, hostname: Hostname.optional() }).extend(ImageSourceFields.shape),
  z.object({ kind: z.literal('compose'), name: ProjectName, hostname: Hostname.optional() }).extend(ComposeVersionFields.shape),
]);
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

/** Name and kind never change. Compose changes go through a new compose version. */
export const UpdateProjectInput = z
  .object({ hostname: Hostname })
  .extend(ImageSourceFields.shape)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

export const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'must be a valid environment variable name');
const EnvValue = z.string().max(64 * 1024).refine((v) => !v.includes('\0'), 'must not contain NUL');

/** MCP `set_env`: set some keys and unset others, leaving the rest alone. */
export const SetEnvInput = z
  .object({
    set: z.record(EnvKey, z.object({ value: EnvValue, secret: z.boolean().default(false) })).default({}),
    unset: z.array(EnvKey).default([]),
  })
  .refine((v) => !v.unset.some((k) => k in v.set), 'a key cannot be both set and unset');
export type SetEnvInput = z.infer<typeof SetEnvInput>;

/**
 * `PUT /api/projects/:id/env`: the full list of env vars. Because secrets are
 * write-only, an existing secret can be kept by sending it without a value.
 */
export const ReplaceEnvInput = z
  .array(z.object({ key: EnvKey, value: EnvValue.optional(), secret: z.boolean().default(false) }))
  .max(500)
  .refine((list) => new Set(list.map((e) => e.key)).size === list.length, 'keys must be unique');
export type ReplaceEnvInput = z.infer<typeof ReplaceEnvInput>;

export const DeployInput = z
  .object({
    digest: Digest.optional(),
    composeVersion: z.number().int().positive().optional(),
  })
  .refine((v) => !(v.digest && v.composeVersion), 'pass a digest or a compose version, not both');
export type DeployInput = z.infer<typeof DeployInput>;

export const TokenScope = z.enum(['read', 'deploy', 'admin']);
export type TokenScope = z.infer<typeof TokenScope>;

export const CreateTokenInput = z.object({
  name: z.string().trim().min(1).max(100),
  scope: TokenScope,
  expiresAt: z.iso.datetime().refine((d) => Date.parse(d) > Date.now(), 'must be in the future').nullable().optional(),
});
export type CreateTokenInput = z.infer<typeof CreateTokenInput>;
