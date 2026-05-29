# 卡密兑换充值前端

React + Vite 前端，用于卡密查询、输入 Token JSON、确认账户后兑换充值、查看本地查询记录和库存标签。

页面包含两个前端路由：

- `/#/`：卡密兑换主流程
- `/#/records`：当前浏览器本地卡密充值记录

Token 输入格式为完整 JSON，至少包含 `account.id`、`accessToken` 和 `sessionToken`。兑换时前端会从 `account.id` 提取后端需要的 `client_id`：

```json
{
  "user": {
    "email": "user@example.com"
  },
  "account": {
    "id": "5ad0a5c2-e5e7-48d1-b694-a7776081e519"
  },
  "expires": "2026-08-26T15:03:36.143Z",
  "accessToken": "...",
  "sessionToken": "..."
}
```

步骤 2 只有在卡密查询通过且状态为未兑换时才会显示。“获取账号信息”会打开官方 ChatGPT session 页面或 OpenAI 登录页。出于浏览器跨域限制和账号凭证安全，前端不会自动读取或填入 `chatgpt.com` 的 session token。

库存标签默认只展示接口返回的 `label`。点击库存标签后可在弹窗里输入授权码查看实际 `count`。

## 本地运行

```bash
npm install
npm run dev
```

前端默认请求同源 `/api`。本地开发时由 Vite 代理到 `https://czit.online`，生产部署时由 Nginx 反向代理到 `https://czit.online/api`，避免浏览器跨域问题。

## 构建

```bash
npm run build
```

生产部署时会使用 hash 路由和相对资源路径。构建产物在 `dist/`。

如果要覆盖 API 地址，可以设置：

```bash
VITE_API_BASE_URL=https://czit.online/api npm run build
```

自建服务器推荐不要覆盖 API 地址，保持默认 `/api`，然后使用 Nginx 反向代理。示例配置见 `deploy/nginx-card-recharge.conf`。
