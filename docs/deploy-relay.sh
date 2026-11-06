#!/usr/bin/env bash
#
# 一键部署 PGrefuge 的 GitHub OAuth 中转（Cloudflare Worker）
#
# 用法：
#   bash deploy-relay.sh
#   bash deploy-relay.sh --name my-relay
#
# 前置条件：
#   1. 有 Cloudflare 账号（免费额度足够）
#   2. npx wrangler 可用（脚本会自动用 npx 调用，不要求全局安装）
#   3. 首次运行会要求登录 Cloudflare（浏览器跳转，粘贴一次授权码即可）
#
# 部署完成后脚本会打印 Worker 地址，把它填进：
#   pgrefuge-forum/site/config.js
#     oauthRelayBaseUrl: 'https://<你的-worker>.workers.dev'
#     githubOAuthClientId: 'Iv1.<你的 Client ID>'
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_FILE="$HERE/github-relay-worker.js"
WORKER_NAME="pgrefuge-relay"

while [ $# -gt 0 ]; do
  case "$1" in
    --name) WORKER_NAME="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

echo "==============================================="
echo " PGrefuge GitHub OAuth 中转 部署脚本"
echo "==============================================="
echo

if [ ! -f "$WORKER_FILE" ]; then
  echo "✗ 找不到 Worker 源码：$WORKER_FILE" >&2
  exit 1
fi
echo "✓ 找到 Worker 源码：$WORKER_FILE"

# ---- 检查 wrangler ----
if ! command -v npx >/dev/null 2>&1; then
  echo "✗ 需要 Node.js（提供 npx）。请先安装 Node.js 18+。" >&2
  exit 1
fi

echo
echo "→ 检查 Cloudflare 登录状态…"
if ! npx --yes wrangler@latest whoami >/dev/null 2>&1; then
  echo "  未登录。即将打开浏览器完成 Cloudflare 授权…"
  echo "  （只需做一次）"
  npx --yes wrangler@latest login
fi
echo "✓ Cloudflare 已登录"

echo
echo "→ 部署 Worker：$WORKER_NAME …"
npx --yes wrangler@latest deploy "$WORKER_FILE" \
  --name "$WORKER_NAME" \
  --compatibility-date 2024-11-01 \
  --no-bundle

echo
echo "==============================================="
echo " ✓ 部署完成"
echo "==============================================="
echo
echo "下一步："
echo
echo "1) 把上面的 Worker 地址填进 pgrefuge-forum/site/config.js："
echo
echo "     oauthRelayBaseUrl: 'https://<上面的地址>',"
echo "     githubOAuthClientId: 'Iv1.<你的 Client ID>',"
echo
echo "2) Client ID 来自 GitHub → Settings → Developer settings →"
echo "   OAuth Apps → New OAuth App（记得勾选 Enable Device Flow）"
echo
echo "3) 提交 config.js 的改动，Actions 会自动重新部署站点。"
echo
echo "4) 打开站点点「一键绑定」验证。"
echo
echo "提示：Cloudflare 免费额度下，绑定一次的消耗是 2~3 个请求。"
echo
