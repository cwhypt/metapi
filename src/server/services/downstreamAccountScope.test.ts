import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ScopeModule = typeof import('./downstreamAccountScope.js');

describe('downstreamAccountScope', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let hasUsableDownstreamRules: ScopeModule['hasUsableDownstreamRules'];
  let computeDownstreamAccountBalance: ScopeModule['computeDownstreamAccountBalance'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-downstream-scope-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const scopeModule = await import('./downstreamAccountScope.js');

    db = dbModule.db;
    schema = dbModule.schema;
    hasUsableDownstreamRules = scopeModule.hasUsableDownstreamRules;
    computeDownstreamAccountBalance = scopeModule.computeDownstreamAccountBalance;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  async function seedSite(
    accountCount: number,
    balances: Array<{ balance: number; balanceUsed: number; status?: string }>,
  ): Promise<{ site: typeof schema.sites.$inferSelect; accounts: Array<typeof schema.accounts.$inferSelect> }> {
    const site = await db.insert(schema.sites).values({
      name: 'scope-site',
      url: 'https://scope.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const accounts: Array<typeof schema.accounts.$inferSelect> = [];
    for (let i = 0; i < accountCount; i += 1) {
      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: `scope-user-${i}`,
        accessToken: `scope-access-${i}`,
        apiToken: `sk-scope-${i}`,
        balance: balances[i].balance,
        balanceUsed: balances[i].balanceUsed,
        status: balances[i].status ?? 'active',
      }).returning().get();
      accounts.push(account);
    }
    return { site, accounts };
  }

  it('treats empty rules as allow-all unless denyAllWhenEmpty', () => {
    expect(hasUsableDownstreamRules({} as any)).toBe(true);
    expect(hasUsableDownstreamRules({ denyAllWhenEmpty: true } as any)).toBe(false);
    expect(hasUsableDownstreamRules({ denyAllWhenEmpty: true, supportedModels: ['gpt-5'] } as any)).toBe(true);
    expect(hasUsableDownstreamRules({ denyAllWhenEmpty: true, allowedRouteIds: [1] } as any)).toBe(true);
  });

  it('sums balance across active accounts on active sites', async () => {
    const { accounts } = await seedSite(2, [
      { balance: 30, balanceUsed: 3 },
      { balance: 20, balanceUsed: 2 },
    ]);
    const summary = await computeDownstreamAccountBalance({} as any);
    expect(summary).toEqual({ balance: 50, used: 5, accountCount: 2 });
  });

  it('returns zero when there are no usable rules', async () => {
    await seedSite(1, [{ balance: 30, balanceUsed: 3 }]);
    const summary = await computeDownstreamAccountBalance({ denyAllWhenEmpty: true } as any);
    expect(summary).toEqual({ balance: 0, used: 0, accountCount: 0 });
  });

  it('excludes disabled accounts and disabled sites', async () => {
    const { site, accounts } = await seedSite(2, [
      { balance: 30, balanceUsed: 3, status: 'disabled' },
      { balance: 20, balanceUsed: 2 },
    ]);
    await db.update(schema.sites).set({ status: 'disabled' })
      .where(eq(schema.sites.id, site.id)).run();

    const summary = await computeDownstreamAccountBalance({} as any);
    expect(summary).toEqual({ balance: 0, used: 0, accountCount: 0 });
  });

  it('restricts to accounts reachable through allowed routes', async () => {
    const { site, accounts } = await seedSite(2, [
      { balance: 30, balanceUsed: 3 },
      { balance: 20, balanceUsed: 2 },
    ]);
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-mini',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accounts[1].id,
      tokenId: null,
      enabled: true,
    });

    const summary = await computeDownstreamAccountBalance({ allowedRouteIds: [route.id] } as any);
    expect(summary).toEqual({ balance: 20, used: 2, accountCount: 1 });
  });

  it('excludes whole sites via excludedSiteIds', async () => {
    const { site } = await seedSite(1, [{ balance: 30, balanceUsed: 3 }]);
    const summary = await computeDownstreamAccountBalance({ excludedSiteIds: [site.id] } as any);
    expect(summary).toEqual({ balance: 0, used: 0, accountCount: 0 });
  });

  it('excludes an account via default_api_key credential ref', async () => {
    const { site, accounts } = await seedSite(2, [
      { balance: 30, balanceUsed: 3 },
      { balance: 20, balanceUsed: 2 },
    ]);
    const summary = await computeDownstreamAccountBalance({
      excludedCredentialRefs: [{ kind: 'default_api_key', siteId: site.id, accountId: accounts[0].id }],
    } as any);
    expect(summary).toEqual({ balance: 20, used: 2, accountCount: 1 });
  });

  it('excludes an account when all its enabled channels are excluded by account_token refs', async () => {
    const { site, accounts } = await seedSite(2, [
      { balance: 30, balanceUsed: 3 },
      { balance: 20, balanceUsed: 2 },
    ]);
    const accountTokens: Array<typeof schema.accountTokens.$inferSelect> = [];
    for (let i = 0; i < 2; i += 1) {
      const token = await db.insert(schema.accountTokens).values({
        accountId: accounts[0].id,
        name: `tok-${i}`,
        token: `sk-tok-${i}`,
        enabled: true,
        isDefault: i === 0,
      }).returning().get();
      accountTokens.push(token);
    }
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-mini',
      enabled: true,
    }).returning().get();
    for (const token of accountTokens) {
      await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: accounts[0].id,
        tokenId: token.id,
        enabled: true,
      });
    }

    const summary = await computeDownstreamAccountBalance({
      excludedCredentialRefs: accountTokens.map((token) => ({
        kind: 'account_token' as const,
        siteId: site.id,
        accountId: accounts[0].id,
        tokenId: token.id,
      })),
    } as any);
    expect(summary).toEqual({ balance: 20, used: 2, accountCount: 1 });
  });

  it('keeps an account when an account_token ref leaves another usable channel', async () => {
    const { site, accounts } = await seedSite(1, [{ balance: 30, balanceUsed: 3 }]);
    const tokenA = await db.insert(schema.accountTokens).values({
      accountId: accounts[0].id,
      name: 'tok-a',
      token: 'sk-tok-a',
      enabled: true,
      isDefault: true,
    }).returning().get();
    const tokenB = await db.insert(schema.accountTokens).values({
      accountId: accounts[0].id,
      name: 'tok-b',
      token: 'sk-tok-b',
      enabled: true,
      isDefault: false,
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-mini',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values([
      { routeId: route.id, accountId: accounts[0].id, tokenId: tokenA.id, enabled: true },
      { routeId: route.id, accountId: accounts[0].id, tokenId: tokenB.id, enabled: true },
    ]);

    const summary = await computeDownstreamAccountBalance({
      excludedCredentialRefs: [
        { kind: 'account_token', siteId: site.id, accountId: accounts[0].id, tokenId: tokenA.id },
      ],
    } as any);
    expect(summary).toEqual({ balance: 30, used: 3, accountCount: 1 });
  });
});
