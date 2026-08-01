import type { FastifyInstance } from 'fastify';
import {
  authorizeDownstreamToken,
  isModelAllowedByPolicyOrAllowedRoutes,
} from '../../services/downstreamApiKeyService.js';
import { computeDownstreamAccountBalance } from '../../services/downstreamAccountScope.js';
import { listModelsSurface } from '../../proxy-core/surfaces/modelsSurface.js';
import * as routeRefreshWorkflow from '../../services/routeRefreshWorkflow.js';
import { tokenRouter } from '../../services/tokenRouter.js';

const NEW_API_QUOTA_UNITS = 500000;

function toQuotaUnits(value: number): number {
  return Math.round((Number(value) || 0) * NEW_API_QUOTA_UNITS);
}

function extractBearerToken(request: { headers: { authorization?: string } }): string {
  const auth = typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

export async function newApiCompatRoutes(app: FastifyInstance) {
  app.get('/api/user/self', async (request, reply) => {
    const token = extractBearerToken(request);
    if (!token) {
      reply.code(401);
      return { error: { message: 'Missing Authorization header' } };
    }
    const result = await authorizeDownstreamToken(token);
    if (!result.ok) {
      reply.code(result.statusCode);
      return { error: { message: result.error } };
    }
    const summary = await computeDownstreamAccountBalance(result.policy);
    return {
      success: true,
      data: {
        id: result.key?.id ?? 1,
        username: result.key?.name || 'metapi',
        email: '',
        role: 1,
        quota: toQuotaUnits(summary.balance),
        used_quota: toQuotaUnits(summary.used),
      },
    };
  });

  app.get('/api/user/models', async (request, reply) => {
    const token = extractBearerToken(request);
    if (!token) {
      reply.code(401);
      return { error: { message: 'Missing Authorization header' } };
    }
    const result = await authorizeDownstreamToken(token);
    if (!result.ok) {
      reply.code(result.statusCode);
      return { error: { message: result.error } };
    }
    const surface = await listModelsSurface({
      downstreamPolicy: result.policy,
      responseFormat: 'openai',
      tokenRouter,
      refreshModelsAndRebuildRoutes: routeRefreshWorkflow.refreshModelsAndRebuildRoutes,
      isModelAllowed: isModelAllowedByPolicyOrAllowedRoutes,
    });
    const models = Array.isArray(surface?.data)
      ? surface.data.map((item: { id?: unknown }) => (typeof item?.id === 'string' ? item.id : ''))
      : [];
    return {
      success: true,
      data: models.filter((modelName: string) => modelName.length > 0),
    };
  });
}
