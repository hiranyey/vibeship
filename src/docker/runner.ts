/** Called with each line of output from a Docker command, for deploy logs. */
export type LineSink = (stream: 'stdout' | 'stderr', line: string) => void;

export type RegistryAuth = { host: string; username: string; password: string };

/** What Vibeship needs to know about a running (or stopped) container. */
export type ContainerState = {
  status: 'created' | 'running' | 'restarting' | 'paused' | 'exited' | 'removing' | 'dead';
  /** Null when the image has no HEALTHCHECK. */
  health: 'starting' | 'healthy' | 'unhealthy' | null;
  exitCode: number;
  restartCount: number;
  /** The image the container was created from, e.g. `repo@sha256:…`. */
  image: string;
};

export type ComposeTarget = {
  /** Compose project name, which is also the Vibeship project name. */
  project: string;
  /** The project folder holding `compose.yaml` and `.env`. */
  dir: string;
};

/**
 * Everything the deploy engine asks of Docker. The real implementation shells
 * out to the `docker` CLI; tests use a fake.
 */
export interface DockerRunner {
  /** Pulls an image by tag or digest, returning the digest it resolved to. */
  pull(ref: string, auth: RegistryAuth | null, onLine: LineSink): Promise<string>;
  composeUp(target: ComposeTarget, onLine: LineSink): Promise<void>;
  composeDown(target: ComposeTarget, onLine: LineSink): Promise<void>;
  /**
   * Sends a container's log lines to `onLine`, oldest first: the last `tail`
   * lines, then new ones as they come when `follow` is set, until the
   * container stops or `signal` aborts. Throws if there is no such container.
   */
  containerLogs(name: string, opts: { tail: number; follow: boolean; signal?: AbortSignal }, onLine: LineSink): Promise<void>;
  /** Null when no container by that name exists. */
  inspectContainer(name: string): Promise<ContainerState | null>;
}
