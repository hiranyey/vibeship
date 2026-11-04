import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Handler } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/auth.ts';
import type { Services } from '../services/index.ts';
import { createMcpServer } from './server.ts';

/**
 * `/mcp`: MCP over Streamable HTTP, stateless. Each POST gets a fresh server
 * holding the tools the bearer token's scope allows, and a plain JSON reply;
 * the tools return at once (deploy hands back an id to poll), so nothing
 * needs a stream or a session. Only API tokens are accepted, not the browser
 * session, so a page can't drive it with the admin's cookie.
 */
export function mcpRoute(services: Services, publicUrl: string): Handler<AppEnv> {
  return async (c) => {
    const principal = c.get('principal');
    if (principal?.kind !== 'token') {
      throw new AppError('unauthorized', 'MCP needs an API token: send "Authorization: Bearer <token>"');
    }
    if (c.req.method !== 'POST') {
      // Stateless: no standalone event stream (GET) and no session to end (DELETE).
      return c.json({ error: { code: 'method_not_allowed', message: 'Send MCP requests with POST' } }, 405, { Allow: 'POST' });
    }

    const server = createMcpServer({ services, principal, publicUrl });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  };
}
