# 聊天组（Chat）

站点 `www.crazychaos.top/chat/` 的后端，跑在 cloud-mail 的同一个 Cloudflare Worker 里，
对外路径 `/api/chat/*`，同域共享登录 cookie。

## 为什么并入这个 Worker

原先跑在独立 VPS（Node + node:sqlite + systemd，经 cloudflared 隧道暴露）。
并入后：

- **不再需要 VPS**，也没有额外端口/隧道
- **身份同源**：登录态直接复用 cloud-mail 的 JWT（`Authorization` 头或 `.crazychaos.top` 的 cookie），
  不需要再往上游 `/my/loginUserInfo` 校验一次
- 存储全部托管：D1 存结构化数据、KV 存聊天资料与限流、R2 存图片与头像

## 数据怎么分

| 数据 | 位置 | 说明 |
|---|---|---|
| 账号（邮箱/昵称/`user_id`） | D1 `user` 表 | **云端唯一真源，不复制副本** |
| 聊天资料（头像/QQ/公钥/密钥备份/封禁） | KV `chat:user:<userId>` | 账号表里没有的字段，才放这里 |
| 会话、成员、消息、密钥包裹、邀请码、举报、审计、机器人、推送订阅 | D1 `chat_*` 表 | 见 `src/service/chat-schema.js` |
| 图片、加密图片、上传的头像 | R2 `chat/<convId>/<name>`、`chat/avatars/<sha>` | D1 只存引用 |
| VAPID 密钥、限流计数 | KV `chat:vapid`、`chat:rl:*` | 首次自动生成 |
| 在线状态 | 无 | Worker 没有长连接，前端改用轮询 |

`chat_member.user_id` / `chat_message.sender_id` 存的是**数字**，对应 `user.user_id`；
接口返回时换成 `email` 填进 `id` 字段，前端不需要区分。

### 表结构怎么建

DDL 全部幂等，冷启动时由 `ensureSchema()` 一次 `batch()` 执行完，**不需要手动跑 SQL**。
要手工检查可用：

```bash
npx wrangler d1 execute cloudmail --remote --command "SELECT name FROM sqlite_master WHERE name LIKE 'chat_%'"
```

## 关键设计

**游客可读、登录才能发**
`security.js` 对所有 `/chat/*` 走「可选鉴权」：有有效 token/cookie 就 `c.set('user', ...)`，
没有也放行。所以同一套路由同时服务游客和登录用户，权限由业务层判断。

**加密**
- 公开群默认明文入库（管理员可读、游客可读、机器人可转发）
- 私聊、私密群、任何 `encMode='e2ee'` 的群：客户端 ECDH(P-256) → HKDF → AES-GCM，
  群密钥用 AES-KW 逐成员包裹。服务器只中转包裹后的密文，**永远解不开**
- 图片在加密群里也是先在浏览器里加密再上传，服务器存的是 `.bin` 密文，连尺寸都来自客户端元数据

**实时消息**
Workers 没有长连接，SSE 已换掉。前端每 4 秒用 `?after=<lastId>` 拉增量，
会话列表每 15 秒刷新一次，页面隐藏时暂停。

**QQ 机器人**
按群绑定 + 站点级默认机器人兜底；消息落库后立刻入 `chat_bot_queue` 并用 `waitUntil` 推一次，
失败按 5s→300s 指数退避，7 次判失败。cron（`*/30` 与 `0 16`）会再兜一次底。
加密群只推「有新消息」，正文永不出服务器。

**Web Push**
`chat-push.js` 用 WebCrypto 手写 RFC 8291（aes128gcm）+ RFC 8292（VAPID ES256），零依赖。
订阅存 `chat_push_sub`，失效（404/410）自动清理。

## 接口一览

前缀 `/api/chat`。带 🔒 的需要登录，带 👑 的需要站点管理员（`env.admin` 或 `*` 权限）。

```
GET  /health
GET  /me 🔒                     GET  /me/keybackup 🔒
POST /me/keys 🔒                POST /me/qq 🔒
POST /me/avatar 🔒              POST /me/avatar/upload 🔒
GET  /avatar/:name
GET  /public/groups             GET  /users/search 🔒
GET  /users/:id/pubkey 🔒
GET  /conversations 🔒          POST /conversations 🔒
GET  /conversations/:id         PATCH /conversations/:id 🔒
DELETE /conversations/:id 🔒    POST /dm 🔒
POST /conversations/:id/join 🔒
GET|POST /conversations/:id/requests 🔒
POST /conversations/:id/members 🔒
POST /conversations/:id/members/:uid/role 🔒
POST /conversations/:id/kick 🔒  POST /conversations/:id/leave 🔒
GET|POST /conversations/:id/invites 🔒
GET|POST /conversations/:id/my-qq 🔒
POST /conversations/:id/notify 🔒
GET|POST /conversations/:id/messages
POST /conversations/:id/read 🔒
GET  /conversations/:id/keys/me 🔒
GET  /conversations/:id/keys/members 🔒
POST /conversations/:id/keys 🔒
POST /upload 🔒                  GET  /blob/*
GET  /push/config                POST|DELETE /push/subscribe 🔒
POST /push/test 🔒
POST /reports 🔒                 GET  /bots 🔒
POST /bot/hook                   （用机器人 secret 校验）

GET  /admin/stats 👑             GET  /admin/users 👑
POST /admin/users/:id 👑         GET  /admin/groups 👑
POST /admin/groups/:id 👑        GET  /admin/reports 👑
POST /admin/reports/:id 👑       GET  /admin/audit 👑
GET|POST /admin/bots 👑          DELETE /admin/bots/:id 👑
POST /admin/bots/:id/test 👑     GET  /admin/bot-queue 👑
GET|POST /admin/settings 👑
```

## 本地开发与测试

```bash
cd mail-worker

# 1) 建一个本地测试配置（不要提交，含占位 id 即可）
cat > wrangler.local-test.toml <<'EOF'
name = "cloud-mail"
main = "src/index.js"
compatibility_date = "2025-06-04"
[[d1_databases]]
binding = "db"
database_name = "cloudmail"
database_id = "00000000-0000-0000-0000-000000000000"
[[kv_namespaces]]
binding = "kv"
id = "00000000000000000000000000000000"
[[r2_buckets]]
binding = "r2"
bucket_name = "taffy"
[vars]
jwt_secret = "local-test-secret-please-change"
admin = "admin@crazychaos.top"
EOF

# 2) 起本地 Worker（本地 D1/KV/R2 模拟）
npx wrangler dev -c wrangler.local-test.toml --port 8799 --local --persist-to .wrangler/teststate
```

要跑 `test/workers-smoke.mjs`，需要先在本地库里造几个账号并把登录态写进 KV：

```bash
# 建 user 表（真实环境由 cloud-mail 初始化脚本建好，本地模拟需要自己造）
npx wrangler d1 execute cloudmail --local --persist-to .wrangler/teststate \
  -c wrangler.local-test.toml \
  --command "CREATE TABLE IF NOT EXISTS user (user_id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, nickname TEXT, type INTEGER DEFAULT 1, password TEXT, salt TEXT, status INTEGER DEFAULT 0, create_time TEXT, active_time TEXT, is_del INTEGER DEFAULT 0);"

# 写登录态（token 任意字符串，JWT 由测试脚本用同一个 jwt_secret 签）
npx wrangler kv key put --local --persist-to .wrangler/teststate \
  -c wrangler.local-test.toml --binding kv "auth-uid:2" \
  '{"user":{"userId":2,"email":"alice@crazychaos.top","nickname":"爱丽丝","permKeys":[]},"tokens":["tok-alice"],"refreshTime":"2026-10-30T00:00:00.000Z"}'

# 跑回归（94 项）
node test/workers-smoke.mjs
```

> 限流是 KV 计数的，短时间反复跑会被 `chat:rl:*` 拦住（建群 5 次/分钟）。
> 重跑前把它清掉：`npx wrangler kv key delete --local ... --binding kv "chat:rl:cc:2"`

## 部署

推 `mail-worker/**` 到 `main` 即可，GitHub Actions 会自动 `wrangler deploy`。
DDL 由 Worker 首次请求时自动执行，部署后不需要额外操作。

验证上线：

```bash
curl https://mail.crazychaos.top/api/chat/health
# {"code":200,...,"data":{"ok":true,"runtime":"cloudflare-workers","r2":true,"d1":true}}
```

## 前端

页面在 `SubscribeTaFFyNya/chat/`（`index.html` + `sw.js`），由 `taffy-chat/frontend/build.py`
从模板 + `chat.{css,html,js}` 生成，**不要手改生成物**。

接口基址在 `chat.js` 顶部：

```js
var CHAT_ORIGIN = 'https://mail.crazychaos.top';
var CHAT_API = CHAT_ORIGIN + '/api';
```
