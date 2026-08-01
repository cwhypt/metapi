# new-api 兼容余额接口（/api/user/self）调试文档

> 分支：`feat/newapi-user-self-balance`
> 用途：让另一台 metapi（或其他 new-api 协议客户端）直接读取本机余额，并按「下游密钥」分别显示账号余额，不再依赖 cliproxy 中转。

## 1. 功能概述

本机对外暴露两个 new-api 兼容端点：

| 端点 | 作用 |
| --- | --- |
| `GET /api/user/self` | 返回当前 token 的余额（quota）与已用额度（used_quota） |
| `GET /api/user/models` | 返回当前 token 可用模型列表 |

- 鉴权同时接受两种 token：全局代理 token（`PROXY_TOKEN`）与已管理下游密钥（`downstreamApiKeys`）。
- 余额不是全局一个数字，而是按 token 的 `DownstreamRoutingPolicy` 算出其「允许使用的账号集合」的余额之和，**与真实转发路由保持一致**。

## 2. 涉及文件

| 文件 | 改动 |
| --- | --- |
| `src/server/routes/proxy/newApiCompat.ts` | 新增，两个端点本体 |
| `src/server/services/downstreamAccountScope.ts` | 新增，按 policy 计算账号范围与余额 |
| `src/server/services/tokenRouter.ts` | `default_api_key` 排除从「默认 key 通道」升级为「整账号排除」 |
| `src/server/desktop.ts` | `isPublicApiRoute` 白名单加入 `/api/user/self`、`/api/user/models` |
| `src/server/index.ts` | 注册 `newApiCompatRoutes`（在 proxyRoutes 之后） |
| `src/web/pages/downstream-keys/DownstreamKeyEditorModal.tsx` | 新增「允许使用的账号」多选面板 |
| `src/web/pages/DownstreamKeys.tsx` | 加载账号选项并传给弹窗 |

测试文件：

- `src/server/routes/proxy/newApiCompat.test.ts`
- `src/server/services/downstreamAccountScope.test.ts`
- `src/server/services/tokenRouter.downstream-policy.test.ts`（新增用例）
- `src/web/pages/DownstreamKeys.test.tsx`（新增用例）

## 3. 请求 / 响应协议

### 3.1 `GET /api/user/self`

请求头：`Authorization: Bearer <token>`

```jsonc
// 200 OK
{
  "success": true,
  "data": {
    "id": 1,                 // 管理 key 时为 key.id，否则为 1
    "username": "for metapi", // 管理 key 时为 key.name，否则 "metapi"
    "email": "",
    "role": 1,
    "quota": 1926180,         // 余额 × 500000
    "used_quota": 50000       // 已用 × 500000
  }
}
```

- 401：无 `Authorization` 头
- 403：token 无效 / 未启用 / 已过期

### 3.2 `GET /api/user/models`

```jsonc
// 200 OK
{ "success": true, "data": ["gpt-5-mini", "..."] }
```

## 4. 鉴权流程（newApiCompat.ts:31）

1. 提取 `Bearer` token；为空 → 401。
2. `authorizeDownstreamToken(token)`（`downstreamApiKeyService.ts`）：
   - 命中 `downstreamApiKeys` 中未过期且启用的 key → 以其 policy 授权。
   - 命中 `PROXY_TOKEN` → 使用全局空 policy（allow-all）。
   - 都不命中 → 403。

## 5. 余额计算逻辑（downstreamAccountScope.ts）

入口：`computeDownstreamAccountBalance(policy)`。

### 5.1 可用性门槛 `hasUsableDownstreamRules`

管理 key 的 policy 恒带 `denyAllWhenEmpty: true`。当 `supportedModels` 与 `allowedRouteIds` 都为空时视为「拒绝一切」：

```ts
supportedModels.length > 0 || allowedRouteIds.length > 0 || policy.denyAllWhenEmpty !== true
```

> 结论：**只配置排除项（账号/站点/凭证）但不配模型或群组的 key，余额为 0**——这与它的真实路由行为一致（模型白名单为空 = 全部拒绝）。

### 5.2 账号范围过滤顺序

1. 只统计 `status='active'` 的账号，且站点 `status='active'`。
2. `allowedRouteIds` 非空时，只保留在启用通道路由（`routeChannels.enabled=true`）上的账号。
3. 排除 `excludedSiteIds` 命中的站点。
4. 排除 `excludedCredentialRefs`：
   - `default_api_key(siteId, accountId)` → 整账号排除（含显式 token 通道）。
   - `account_token(siteId, accountId, tokenId)` → 仅当该账号所有启用通道的 token 都被排除时，才排除该账号。

### 5.3 汇总

余额 = 范围内每个账号 `balance` 之和，已用 = `balanceUsed` 之和。

## 6. 单位换算

- 本机 `accounts.balance` 单位是「元」（如 `3.85236`）。
- new-api 协议 `quota` 单位是「500000 元」的整数倍。
- 出方向：`toQuotaUnits(value) = round(value * 500000)`（newApiCompat.ts:13）。
- 对端（metapi 的 newApi platform）读取时再 `quota / 500000` 还原（`newApi.ts:parseBalance`），往返无损。

## 7. tokenRouter 变更（重要）

**之前**：`default_api_key` 引用只排除「tokenId 为 null 的默认通道」。

**现在**：`default_api_key` 引用排除**整个账号**，即使该账号的通道显式绑定了 account token 也会被排除（`tokenRouter.ts` 中 `default_api_key` 分支匹配任意通道的 accountId）。

影响：下游密钥的「排除 API Key/令牌」面板勾选「默认 API Key」等价于排除该账号全部可用通道。

## 8. UI：允许使用的账号

- 位置：下游密钥编辑弹窗 → 高级配置 →「允许使用的账号」。
- 存储：**不新增 DB 字段**，复用 `excludedCredentialRefs`，用 `default_api_key` 引用表示「未选中账号」：

```
选中集合 = 全部账号 − excludedCredentialRefs 中 default_api_key 引用的账号
```

- 交互：勾选 = 移除该账号的 default_api_key 排除；取消勾选 = 新增该账号的 default_api_key 排除；「全部允许」清空所有 default_api_key 引用；「全部排除」为所有账号加 default_api_key 引用。
- 注意：该面板只管理 `default_api_key` 引用，不触碰 `account_token` 引用（显式令牌排除仍由「排除 API Key/令牌」面板负责）。

## 9. 远程 metapi 配置（消费端）

1. 站点：platform = `new-api`，url = `http://<本机IP>:4056`（如 `http://10.0.0.205:4056`，需网络可达、防火墙放行 4056）。
2. 账号：把下游密钥填进 **access/session token 字段**（如 `sk-3710e6cd…`），点「验证 Token」。
3. 逐个账号分别显示：为每个本机账号创建一个下游密钥，并在编辑弹窗「允许使用的账号」里只勾选对应账号 → 远端每个账号对应一行余额。
4. 想显示全局合计：直接用 `PROXY_TOKEN`（`proxy-sk-token`）作为 token。

### 9.1 为什么必须走 session 模式

对端 metapi 的 `verifyToken` 先探测 `/v1/models`：

- 本机 `/v1/models` 返回空列表 → 不会判成 `apikey`。
- 随后命中 `/api/user/self` 成功 → 判成 **session**。

只有 session 账号才会走余额刷新；若被判成 `apikey`（`isApiKeyConnection`），余额刷新会被跳过（`proxy_only`）。

> 陷阱：**不要把下游密钥填到对端账号的「API Key (sk-…)」字段**，那样会变成 apikey 连接、不刷余额。

## 10. Debug 命令

```bash
# 本机健康检查（无 token → 401，错 token → 403）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4056/api/user/self

# 全局合计
curl -s http://127.0.0.1:4056/api/user/self \
  -H "Authorization: Bearer proxy-sk-token"

# 管理 key 范围余额（该 key 允许的账号之和）
curl -s http://127.0.0.1:4056/api/user/self \
  -H "Authorization: Bearer sk-<下游密钥>"

# 模型列表
curl -s http://127.0.0.1:4056/api/user/models \
  -H "Authorization: Bearer proxy-sk-token"

# 对端 metapi 日志排查：确认 /api/user/self 请求到达
#   日志关键字：/api/user/self、authorizeDownstreamToken
```

## 11. 已知语义边界

- 新增的账号默认「允许」：允许名单本质是「全部 − 排除」，新增账号不在排除集合里即为允许（未做 schema 变更）。
- 余额不按模型可用性二次过滤：`allowedRouteIds`/排除只按账号维度收敛；key 若配了模型白名单，余额是允许账号的总额（上界）。
- 管理 key 只有排除、没有模型/群组时余额为 0（见 5.1）。
- 部署后重启方式：

```bash
setsid nohup node dist/server/index.js > /tmp/metapi.log 2>&1 < /dev/null &
```

（服务监听 `0.0.0.0:4056`，.env 中 `PORT=4056`、`AUTH_TOKEN=admin-token`、`PROXY_TOKEN=proxy-sk-token`。）
