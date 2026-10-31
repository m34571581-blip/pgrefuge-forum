# 部署指南

从零到上线大约 **20 分钟**，不需要买服务器、不需要备案、不需要域名。

---

## Step 1 · 建仓库（2 分钟）

1. 打开 https://github.com/new
2. 仓库名：`pgrefuge-forum`（或你喜欢的）
3. **Public**（必须公开 —— 访客才能看讨论区）
4. 勾上 "Add a README file" 或 "Add .gitignore" 均可
5. Create repository

---

## Step 2 · 开启 Discussions（1 分钟）

1. 进仓库 → **Settings**
2. 左侧 **Features** → 找到 **Discussions** → 勾上
3. 保存

---

## Step 3 · 建 experiences 分类（2 分钟）

1. 进仓库 → **Discussions** 标签页
2. 右上角 **New discussion** → 首次会让你先建一个分类
3. 分类名填 **experiences**（必须完全一致，脚本按这个名字匹配；技术参数一律用英文）
4. Description 随便写一句，比如「匿名分享你的经历。系统会自动脱敏。」
5. Create

> 分类 ID 不用手动填 —— `scripts/sync.js` 会通过 GraphQL 自动查。

---

## Step 4 · 推代码（2 分钟）

```bash
cd pgrefuge-forum
git init
git add .
git commit -m "feat: PGrefuge 匿名论坛初始版本"

# 换成你的仓库地址
git remote add origin https://github.com/你的用户名/pgrefuge-forum.git
git push -u origin main
```

---

## Step 5 · 开启 GitHub Pages（2 分钟）

1. 仓库 → **Settings** → **Pages**
2. Source 选 **GitHub Actions**（不是 Deploy from a branch）
3. 保存

---

## Step 6 · 配置同步工作流（3 分钟）

工作流已经写好在 `.github/workflows/sync.yml`，但 `site/index.html` 里
仓库地址要改成你的：

```bash
# 编辑 site/index.html，找到这行，改成你的用户名
#   const REPO = window.PG_CONFIG && window.PG_CONFIG.repo || 'your-username/pgrefuge-forum'
```

或者更简单——在 `site/index.html` 的 `<script>` 前加一段：

```html
<script>
  window.PG_CONFIG = { repo: '你的用户名/pgrefuge-forum' };
</script>
```

> 更推荐的做法：在 `site/index.html` 里新建一个 `config.js`，
> 写 `window.PG_CONFIG = { repo: '你的用户名/pgrefuge-forum' };`，
> 然后在 `<script>` 标签前加 `<script src="config.js"></script>`。
> 这样改配置不用动主文件。

**然后手动触发一次同步**：

1. 仓库 → **Actions** 标签页
2. 左侧选 **同步论坛数据**
3. 右侧 **Run workflow**
4. 等 1–2 分钟

工作流会：拉取 Discussions → 脱敏 → 生成 `posts.json` → 提交 → 部署到 Pages。

---

## Step 7 · 访问（1 分钟）

页面地址：

```
https://你的用户名.github.io/pgrefuge-forum/
```

---

## 关键点：token 从哪来

工作流用的是 `secrets.GITHUB_TOKEN`（GitHub 自动注入的临时令牌），
**不需要你手动创建 PAT**。但 GraphQL 读 Discussions 需要 `discussions: read` 权限，
`sync.yml` 里已经声明了：

```yaml
permissions:
  contents: write
  discussions: read
  pages: write
  id-token: write
```

如果你想**在本地**跑同步（调试用），才需要自己建 PAT：

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens**
2. **Fine-grained tokens** → Generate new token
3. Repository access 选你的仓库
4. Permissions 里勾 **Discussions: Read-only**
5. 生成后复制（只显示一次）

```bash
GITHUB_TOKEN=ghp_xxx GH_OWNER=你的用户名 GH_REPO=pgrefuge-forum node scripts/sync.js
```

---

## 常见问题

### 同步工作流报错 "discussions: read"

检查 `sync.yml` 的 `permissions` 块是否完整。GitHub 默认可能把权限收窄成只读，
需要显式声明。

### 页面显示「数据还没同步」

说明 `site/posts.json` 没生成。看 Actions 的日志，多半是 GraphQL 报错。
本地跑一次 `node scripts/sync.js` 就能看到具体错误。

### 页面显示「链接不完整」

GitHub Pages 在某些网络环境下有访问保护。检查是否开了隐私保护：
Settings → Pages → 确认 "Enforce HTTPS" 和可见性设置。

### 新建的讨论没出现在论坛上

同步是每 6 小时一次（cron `17 */6 * * *`）。想立刻生效：
Actions → 同步论坛数据 → Run workflow。

### 怎么调整同步频率

编辑 `.github/workflows/sync.yml` 里的 cron。GitHub 的 cron 用 UTC：

```yaml
- cron: '17 */6 * * *'    # 每 6 小时（UTC 1:17/7:17/13:17/19:17）
- cron: '*/30 * * * *'    # 每 30 分钟
- cron: '0 3 * * *'       # 每天 3:00 UTC（北京时间 11:00）
```

注意 GitHub 最短间隔 5 分钟，且**定时任务在高峰期可能延迟**。

---

## 运营：冷启动怎么办

社区产品的死因是「空平台」。第一批内容必须有人写。

**建议的种子策略**：

1. 先用 3–5 条**真实但不刺激**的种子内容打底（可以是身边同学的投稿）
2. **每一条评论都要认真回** —— 空平台的死亡往往是因为「没人回应」
3. 冷启动期把范围收窄：一个院系、一个方向，先做到 20 个活跃用户
4. 别急着推广，先确认「有人发 → 有人回 → 有人再发」这个循环能转起来

**内容审核**：在 GitHub Discussions 里直接操作（删帖、锁帖、删评），
不需要额外工具。
