import type { FastifyInstance } from 'fastify';

const DESKTOP_HEALTH_ROUTE = '/api/desktop/health';
const NEW_API_COMPAT_ROUTES = new Set(['/api/user/self', '/api/user/models']);

export function isPublicApiRoute(url: string): boolean {
  return url === DESKTOP_HEALTH_ROUTE
    || url.startsWith('/api/oauth/callback/')
    || NEW_API_COMPAT_ROUTES.has(url);
}

export async function registerDesktopRoutes(app: FastifyInstance) {
  app.get(DESKTOP_HEALTH_ROUTE, async () => ({ ok: true }));
}
