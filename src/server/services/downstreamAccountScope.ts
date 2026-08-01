import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { DownstreamRoutingPolicy } from './downstreamPolicyTypes.js';

export interface DownstreamBalanceScopeSummary {
  balance: number;
  used: number;
  accountCount: number;
}

export function hasUsableDownstreamRules(policy: DownstreamRoutingPolicy): boolean {
  const supportedModels = Array.isArray(policy.supportedModels) ? policy.supportedModels : [];
  const allowedRouteIds = Array.isArray(policy.allowedRouteIds) ? policy.allowedRouteIds : [];
  return supportedModels.length > 0 || allowedRouteIds.length > 0 || policy.denyAllWhenEmpty !== true;
}

function accountRefKey(siteId: number, accountId: number): string {
  return `${siteId}:${accountId}`;
}

export async function computeDownstreamAccountBalance(
  policy: DownstreamRoutingPolicy,
): Promise<DownstreamBalanceScopeSummary> {
  if (!hasUsableDownstreamRules(policy)) {
    return { balance: 0, used: 0, accountCount: 0 };
  }

  const excludedSiteIds = Array.isArray(policy.excludedSiteIds) ? policy.excludedSiteIds : [];
  const allowedRouteIds = Array.isArray(policy.allowedRouteIds) ? policy.allowedRouteIds : [];
  const excludedCredentialRefs = Array.isArray(policy.excludedCredentialRefs)
    ? policy.excludedCredentialRefs
    : [];

  const activeSiteRows = await db.select({ id: schema.sites.id })
    .from(schema.sites)
    .where(eq(schema.sites.status, 'active'))
    .all();
  if (activeSiteRows.length === 0) {
    return { balance: 0, used: 0, accountCount: 0 };
  }
  const activeSiteIds = activeSiteRows.map((row) => row.id);

  const accountRows = await db.select({
    id: schema.accounts.id,
    siteId: schema.accounts.siteId,
    balance: schema.accounts.balance,
    balanceUsed: schema.accounts.balanceUsed,
  })
    .from(schema.accounts)
    .where(and(
      eq(schema.accounts.status, 'active'),
      inArray(schema.accounts.siteId, activeSiteIds),
    ))
    .all();

  let inScope = accountRows;

  if (allowedRouteIds.length > 0) {
    const channelRows = await db.select({
      accountId: schema.routeChannels.accountId,
    })
      .from(schema.routeChannels)
      .where(and(
        inArray(schema.routeChannels.routeId, allowedRouteIds),
        eq(schema.routeChannels.enabled, true),
      ))
      .all();
    const channelAccountIds = new Set(channelRows.map((row) => row.accountId));
    inScope = inScope.filter((account) => channelAccountIds.has(account.id));
  }

  const excludedSiteIdSet = new Set(excludedSiteIds);
  const defaultApiKeyExcluded = new Set<string>();
  const accountTokenExcludedByAccount = new Map<string, Set<number>>();
  for (const ref of excludedCredentialRefs) {
    if (ref.kind === 'default_api_key') {
      defaultApiKeyExcluded.add(accountRefKey(ref.siteId, ref.accountId));
    } else if (ref.kind === 'account_token') {
      const key = accountRefKey(ref.siteId, ref.accountId);
      const set = accountTokenExcludedByAccount.get(key) ?? new Set<number>();
      set.add(ref.tokenId);
      accountTokenExcludedByAccount.set(key, set);
    }
  }

  let channelsByAccount: Map<number, Array<{ tokenId: number | null }>> | null = null;
  if (accountTokenExcludedByAccount.size > 0) {
    const involvedAccountIds = inScope
      .filter((account) => accountTokenExcludedByAccount.has(accountRefKey(account.siteId, account.id)))
      .map((account) => account.id);
    if (involvedAccountIds.length > 0) {
      const rows = await db.select({
        accountId: schema.routeChannels.accountId,
        tokenId: schema.routeChannels.tokenId,
      })
        .from(schema.routeChannels)
        .where(and(
          inArray(schema.routeChannels.accountId, involvedAccountIds),
          eq(schema.routeChannels.enabled, true),
        ))
        .all();
      channelsByAccount = new Map();
      for (const row of rows) {
        const list = channelsByAccount.get(row.accountId) ?? [];
        list.push({ tokenId: row.tokenId });
        channelsByAccount.set(row.accountId, list);
      }
    }
  }

  let balance = 0;
  let used = 0;
  let accountCount = 0;

  for (const account of inScope) {
    const refKey = accountRefKey(account.siteId, account.id);
    if (excludedSiteIdSet.has(account.siteId)) continue;
    if (defaultApiKeyExcluded.has(refKey)) continue;

    const excludedTokenIds = accountTokenExcludedByAccount.get(refKey);
    if (excludedTokenIds && excludedTokenIds.size > 0) {
      const channels = channelsByAccount?.get(account.id) ?? [];
      if (channels.length > 0) {
        const hasUsableChannel = channels.some(
          (channel) => channel.tokenId == null || !excludedTokenIds.has(channel.tokenId),
        );
        if (!hasUsableChannel) continue;
      }
    }

    balance += Number(account.balance || 0);
    used += Number(account.balanceUsed || 0);
    accountCount += 1;
  }

  return { balance, used, accountCount };
}
