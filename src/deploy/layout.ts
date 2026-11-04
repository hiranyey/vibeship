// The layout every project shares on the host and inside Docker. The deploy
// code and the MCP deploy guide both read these, so the guide can't describe
// a different layout from the one deployed.

/** The external network Caddy, Vibeship and every project's routed container join. */
export const WEB_NETWORK = 'web';

/** The generated compose file in each project folder. */
export const COMPOSE_FILE = 'compose.yaml';

/** The generated env file in each project folder; holds decrypted values, secrets included. */
export const ENV_FILE = '.env';
export const ENV_FILE_MODE = 0o600;

/** The project's persistent folder, `<STACK_ROOT>/<project>/data`. */
export const DATA_DIR = 'data';

/** Where an image project's container sees `data/`. */
export const IMAGE_DATA_MOUNT = '/data';
