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
#     githubOAuthClientId: '<你的 Client ID>'   # OAuth App 形如 Ov23li...，原样填入，不要加前缀
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
#
# 注意：这里不能只看 whoami 的退出码，也不能粗略 grep "account"。
#
# 实测踩过的坑：
#   - 非交互环境下 wrangler 因「需要 CLOUDFLARE_API_TOKEN」而失败，但**退出码仍是 0**
#     → 只看退出码会误判「已登录」
#   - 未登录时它输出的 "To deploy without logging in, ... temporary account"
#     里含 "account" → 粗略 grep "account" 同样会误判
#
# 所以判据是：**必须出现明确的已登录标志**，且**不能出现未登录标志**。
# wrangler 登录成功后会打出 "You are logged in with an account" 之类，
# 未登录时则是 "You are not authenticated"。
WHOAMI_OUT="$(npx --yes wrangler@latest whoami 2>&1 || true)"

if echo "$WHOAMI_OUT" | grep -qi "not authenticated"; then
  LOGGED_IN=0
elif echo "$WHOAMI_OUT" | grep -qiE "you are logged in|logged in with|account id|Account:"; then
  LOGGED_IN=1
else
  LOGGED_IN=0
fi

if [ "$LOGGED_IN" = "1" ]; then
  echo "✓ Cloudflare 已登录"
elif [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "✓ 使用环境变量 CLOUDFLARE_API_TOKEN"
else
  echo "  未登录。即将打开浏览器完成 Cloudflare 授权…"
  echo "  （只需做一次，浏览器会给你一个授权码，粘贴回终端）"
  echo
  echo "  如果浏览器没自动打开，手动打开这个链接完成授权："
  echo "    https://dash.cloudflare.com/profile/api-tokens"
  echo
  npx --yes wrangler@latest login || {
    echo
    echo "✗ 登录失败。也可以改用 API Token 方式："
    echo "  1) 打开 https://dash.cloudflare.com/profile/api-tokens"
    echo "  2) Create Token → 选 'Edit Cloudflare Workers' 模板"
    echo "  3) 设 CLOUDFLARE_API_TOKEN 环境变量后重跑本脚本"
    exit 1
  }
fi

echo
echo "→ 部署 Worker：$WORKER_NAME …"

#
# ---- 前置检查：workers.dev 子域名是否已注册 ----
#
# 首次部署前必须先注册一个 workers.dev 子域名，
# 否则 wrangler 会弹出交互式提问「Would you like to register a workers.dev subdomain now?」，
# 而在非交互环境里它会拿 fallback 值（no）→ 部署直接失败。
#
# 这个注册是**一次性的**（账号级），注册后所有 Worker 都能用。
#
# 检测方式：直接问 wrangler 部署能不能通 —— 但更干净的做法是
# 从 whoami 输出里找账号信息；找不到就引导用户去 Dashboard 注册。
# **不要把账号 ID 写死在脚本里** —— 每个用户的账号 ID 都不同。
#
WHOAMI2="$(npx --yes wrangler@latest whoami 2>&1 || true)"
ACCOUNT_ID="$(echo "$WHOAMI2" | grep -oE '[0-9a-f]{32}' | head -1)"

#
# ---- 部署 Worker ----
#
# 部署失败时把 wrangler 的输出完整打出来 ——
# wrangler 的错误信息在最后几行（X [ERROR] ...），
# 但前面有大量 banner，只看尾部容易漏掉关键信息。
#
# 关于「workers.dev 子域名是否已注册」：
#
#   最早这里有个前置检查，用「whoami 输出里有没有 workers.dev」来判断 ——
#   错。子域名**不会**出现在 whoami 输出里，
#   所以即使早就注册好了也永远误判，脚本每次都让用户去注册。
#   试过改用 Cloudflare API 查 /workers/subdomain 也不行 ——
#   凭据文件路径在各平台都不一样（Windows 上是
#   AppData/Roaming/xdg.config/.wrangler/），写死路径不可靠。
#
#   现在的做法：**直接部署，让 wrangler 自己判断**。
#   子域名没注册时它会报明确的错误，我们据此给指引；
#   已注册时直接部署成功，什么都不用问。
#   这比任何预检查都可靠 —— 预检查本身可能出错，部署不会。
#
DEPLOY_OUT="$(npx --yes wrangler@latest deploy "$WORKER_FILE" \
  --name "$WORKER_NAME" \
  --compatibility-date 2024-11-01 \
  --no-bundle 2>&1)" && DEPLOY_OK=1 || DEPLOY_OK=0

echo "$DEPLOY_OUT"

if [ "$DEPLOY_OK" != "1" ]; then
  echo
  echo "==============================================="
  echo " ✗ 部署失败"
  echo "==============================================="
  echo

  # 子域名没注册是最常见的原因，而且 wrangler 的报错需要转译一下
  # （原始信息是英文的 "Would you like to register a workers.dev subdomain now?"）
  if echo "$DEPLOY_OUT" | grep -qi "subdomain"; then
    echo "原因：还没注册 workers.dev 子域名（首次部署必需，一次性操作）。"
    echo
    if [ -n "$ACCOUNT_ID" ]; then
      echo "  请打开这个链接完成注册："
      echo "    https://dash.cloudflare.com/$ACCOUNT_ID/workers/onboarding"
    else
      echo "  请打开 Cloudflare Dashboard → Workers & Pages → Onboarding："
      echo "    https://dash.cloudflare.com/ → Workers & Pages"
    fi
    echo
    echo "  点「Get started」→ 选 Free 计划 → 输入一个子域名前缀（比如 pgrefuge）"
    echo "  注册完再重跑本脚本。"
    echo
    exit 1
  fi

  echo "常见原因："
  echo "  · 未登录 Cloudflare —— 跑 npx wrangler login"
  echo "  · API Token 权限不足 —— 需 'Edit Cloudflare Workers' 模板"
  echo "  · Workers 付费额度未开通 —— Dashboard → Workers → 启用免费计划"
  echo "  · 网络代理拦截 —— 检查 HTTP_PROXY / HTTPS_PROXY"
  echo
  exit 1
fi

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
echo "     githubOAuthClientId: '<你的 Client ID>',"
echo
echo "2) Client ID 来自 GitHub → Settings → Developer settings →"
echo "   OAuth Apps → 你的应用（记得勾选 Enable Device Flow）"
echo "   Client ID 是公开标识符，不是密钥，可以放在前端。"
echo
echo "3) 提交 config.js 的改动，Actions 会自动重新部署站点。"
echo
echo "4) 打开站点点「一键绑定」验证。"
echo
echo "提示：Cloudflare 免费额度下，绑定一次的消耗是 2~3 个请求。"
echo
