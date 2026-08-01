import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');
type CompatModule = typeof import('./newApiCompat.js');
type ConfigModule = typeof import('../../config.js');

describe('new-api compatible /api/user/self balance route', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let newApiCompatRoutes: CompatModule['newApiCompatRoutes'];
  let config: ConfigModule['config'];
  let app: FastifyInstance;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-newapi-compat-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const compatModule = await import('./newApiCompat.js');
    const configModule = await import('../../config.js');

    db = dbModule.db;
    schema = dbModule.schema;
    newApiCompatRoutes = compatModule.newApiCompatRoutes;
    config = configModule.config;
    config.proxyToken = 'sk-global-proxy-token';

    app = Fastify();
    await app.register(newApiCompatRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  let siteSeedCounter = 0;
  async function seedSiteAndAccounts(
    balances: Array<{ balance: number; balanceUsed: number; status?: string; siteStatus?: string }>,
  ): Promise<{ site: typeof schema.sites.$inferSelect; accounts: Array<typeof schema.accounts.$inferSelect> }> {
    const seed = siteSeedCounter;
    siteSeedCounter += 1;
    const site = await db.insert(schema.sites).values({
      name: `seed-site-${seed}`,
      url: `https://seed-${seed}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const accounts: Array<typeof schema.accounts.$inferSelect> = [];
    for (const item of balances) {
      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: `user-${accounts.length}`,
        accessToken: `access-${accounts.length}`,
        apiToken: `sk-default-${accounts.length}`,
        balance: item.balance,
        balanceUsed: item.balanceUsed,
        status: item.status ?? 'active',
      }).returning().get();
      accounts.push(account);
    }
    return { site, accounts };
  }

  it('returns 401 without an Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/user/self' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for an invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/user/self',
      headers: { authorization: 'Bearer sk-not-real' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns aggregate balance for the global proxy token', async () => {
    await seedSiteAndAccounts([
      { balance: 10, balanceUsed: 2 },
      { balance: 5, balanceUsed: 1 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/user/self',
      headers: { authorization: 'Bearer sk-global-proxy-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.quota).toBe(15 * 500000);
    expect(body.data.used_quota).toBe(3 * 500000);
  });

  it('returns zero balance when there are no active accounts', async () => {
    await seedSiteAndAccounts([{ balance: 10, balanceUsed: 2, status: 'disabled' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/user/self',
      headers: { authorization: 'Bearer sk-global-proxy-token' },
    });
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.quota).toBe(0);
    expect(body.data.used_quota).toBe(0);
  });

  it('scopes balance to accounts reachable through allowed routes for a managed key', async () => {
    const { site } = await seedSiteAndAccounts([
      { balance: 100, balanceUsed: 10 },
      { balance: 50, balanceUsed: 5 },
    ]);
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-mini',
      enabled: true,
    }).returning().get();
    const allAccounts = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.siteId, site.id))
      .all();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: allAccounts[0].id,
      tokenId: null,
      enabled: true,
    });

    const key = await db.insert(schema.downstreamApiKeys).values({
      name: 'scoped',
      key: 'sk-managed-scoped',
      enabled: true,
      allowedRouteIds: JSON.stringify([route.id]),
    }).returning().get();

    const res = await app.inject({
      method: 'GET',
      url: '/api/user/self',
      headers: { authorization: `Bearer ${key.key}` },
    });
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.quota).toBe(100 * 500000);
    expect(body.data.used_quota).toBe(10 * 500000);
  });

  it('excludes accounts on excluded sites', async () => {
    const { site: excludedSite } = await seedSiteAndAccounts([
      { balance: 100, balanceUsed: 10 },
    ]);
    const { site: allowedSite } = await seedSiteAndAccounts([
      { balance: 40, balanceUsed: 4 },
    ]);

    const key = await db.insert(schema.downstreamApiKeys).values({
      name: 'exclude-site',
      key: 'sk-managed-exclude-site',
      enabled: true,
      supportedModels: JSON.stringify(['gpt-5-mini']),
      excludedSiteIds: JSON.stringify([excludedSite.id]),
    }).returning().get();

    const res = await app.inject({
      method: 'GET',
      url: '/api/user/self',
      headers: { authorization: `Bearer ${key.key}` },
    });
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.quota).toBe(40 * 500000);
    expect(body.data.used_quota).toBe(4 * 500000);
  });

  it('excludes an account targeted by a default_api_key credential ref', async () => {
    const { site, accounts } = await seedSiteAndAccounts([
      { balance: 100, balanceUsed: 10 },
      { balance: 50, balanceUsed: 5 },
    ]);

    const key = await db.insert(schema.downstreamApiKeys).values({
      name: 'exclude-account',
      key: 'sk-managed-exclude-account',
      enabled: true,
      supportedModels: JSON.stringify(['gpt-5-mini']),
      excludedCredentialRefs: JSON.stringify([
        { kind: 'default_api_key', siteId: site.id, accountId: accounts[0].id },
      ]),
    }).returning().get();

    const res = await app.inject({
      method: 'GET',
      url: '/api/user/self',
      headers: { authorization: `Bearer ${key.key}` },
    });
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.quota).toBe(50 * 500000);
    expect(body.data.used_quota).toBe(5 * 500000);
  });

  it('returns zero for a managed key that denies all models', async () => {
    await seedSiteAndAccounts([{ balance: 100, balanceUsed: 10 }]);

    const key = await db.insert(schema.downstreamApiKeys).values({
      name: 'no-rules',
      key: 'sk-managed-no-rules',
      enabled: true,
      excludedSiteIds: JSON.stringify([999]),
    }).returning().get();

    const res = await app.inject({
      method: 'GET',
      url: '/api/user/self',
      headers: { authorization: `Bearer ${key.key}` },
    });
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.quota).toBe(0);
  });

  it('returns model list for a valid token', async () => {
    await seedSiteAndAccounts([{ balance: 10, balanceUsed: 0 }]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/user/models',
      headers: { authorization: 'Bearer sk-global-proxy-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
});
