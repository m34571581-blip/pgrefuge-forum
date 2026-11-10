# PGrefuge · 研究生庇护所

> 面向在校研究生的匿名倾诉社区。**服务端强制脱敏，不采集任何身份信息。**

一个跑在 GitHub 上的匿名论坛 —— 零服务器、零备案、零域名成本。

---

## 为什么用 GitHub 承载

这个项目最早是微信小程序。做完后评估上线成本，发现 UGC 类目绕不开两道坎：

| 卡点 | 成本 |
|---|---|
| 小程序备案（工信部 ICP） | 7–20 个工作日 |
| 社交类目资质 + 首次提审网信办审核 | 约 7 天 |
| 企业/个体户主体 + 微信认证 | 约 250 元 + 3–6 周 |

对一个**需要真实用户数据来验证核心假设**的产品来说，这个等待期是不可接受的 ——
而且真正稀缺的不是「能上线的壳」，是**真实语料**。

于是把承载层换成 GitHub：

| 需求 | GitHub 上的解法 |
|---|---|
| 像论坛一样，每人发经历 | Discussions 主题 = 帖子，评论 = 回应 |
| 零运营开发成本 | 免费额度足够，无服务器、无备案、无域名 |
| **收集真实信息** | GraphQL API 拿到全量结构化内容（正文/时间/互动） |
| 审核 | 直接在 GitHub 侧删帖/锁帖/删评 |

**架构上的关键决定**：GitHub Discussions 是**私有讨论区**（需登录才能看原帖），
对外的静态站只展示**脱敏后**的内容。数据管道是单向的：

```
GitHub Discussions  ──▶  脱敏引擎  ──▶  静态论坛 + posts.json
  （原始，未脱敏）      （强制执行）      （唯一对外暴露的内容）
```

---

## 核心机制：脱敏引擎

匿名是这个产品唯一不可妥协的承诺。但**匿名不能靠用户自觉** ——
用户恰恰是在情绪最激动、最少考虑后果的时候填写内容。

所以脱敏是**服务端强制**的，8 级级联管道：

| 级 | 作用 |
|---|---|
| p1 | 泛称 + 称谓保护（「其他老师」不被拆成「某老师」） |
| p2 | 泛称 + 机构词保护（「今天实验室」不被拆成「某实验室」） |
| p3 | 「的」占位（避免姓名规则把「的」当姓氏） |
| p4–p8 | 学校/学院/课题组/姓名+称谓/姓氏 → 占位符替换 |

### 精度是双向的

脱敏不是「越狠越好」。改得面目全非，用户就失去了倾诉价值。

| 原文 | 输出 | 说明 |
|---|---|---|
| 我们学院的**李老师** | 我们学院的**某老师** | 姓名替换，泛称保留 |
| **星洲大学**读研 | **某校**读研 | 校名替换 |
| 每天在**实验室**待到十点 | 不变 | 「实验室」不含可识别信息，误伤是 bug |
| **隔壁学院**的同学说 | 不变 | 泛称，不是具体学校 |
| **今天实验室**停电了 | 不变 | 同上 |

### 实测准确率

```bash
node scripts/eval.js
```

```
样本数：37
[召回] 该脱敏的样本是否脱敏      14/14  召回率 100.0%
[精确] 不该脱敏的样本是否保持原样  23/23  精确率 100.0%
[一致性] 论坛版 vs 小程序版        37/37 零漂移
```

**为什么要做这个评测**：最初只有 3 条冒烟断言，回答不了「它到底有多准」。
建了标注样本集后，一次就跑出三类真实缺陷：

| 缺陷 | 现象 | 根因 |
|---|---|---|
| 虚词吞并 | `我们在湖南大学读研` → `我某校读研` | 否定断言只检查捕获组**首字符** |
| 泛称误伤 | `隔壁学院` → `某学院` | 泛称词表缺「隔壁/附近/对面」 |
| 动词误伤 | `每天在实验室` → `某实验室` | 词表缺时间状语与动词 |

第一个是最值得说的：断言只挡下了开头的「我」，捕获组照旧向右吃进「们在湖南」，
虚词和地名一起消失。**把断言下沉到每个字符才修好。**

---

## 匿名化：GitHub 用户名 → 诗意代号

公开站上不能出现 GitHub 用户名。同步管道给每个用户分配一个稳定代号：

```
student_a  →  晚风
student_b  →  旧书页
student_c  →  雨巷
```

代号**稳定**（同一用户永远是同一个），按 login 排序后分配，保证每次同步不漂移。

---

## 目录结构

```
pgrefuge-forum/
├── site/                    # GitHub Pages 托管的静态站
│   ├── index.html           #   论坛前端（单文件，无构建步骤）
│   └── posts.json           #   同步生成的数据（帖子 + 评论 + 统计）
├── scripts/
│   ├── desensitize.js       # 脱敏引擎（与小程序端共用同一份规则）
│   ├── sync.js              # 同步管道：拉取 → 脱敏 → 生成
│   ├── harden-site.js       # 反逆向加固：site/ → dist/ + 三道等价校验
│   └── eval.js              # 准确率评测 + 跨项目一致性校验
├── dist/                    # 加固后的发布产物（生成物，不进 git）
├── data/
│   ├── posts.json           # 数据集（结构化，可直接分析）
│   └── .raw-cache.json      # 原始缓存（离线调试用）
├── .github/workflows/
│   ├── sync.yml             # 每 30 分钟自动同步 + 加固 + 部署
│   └── check-sensitive.yml  # 敏感信息检查（push / PR 都跑）
├── .githooks/
│   └── pre-commit           # 提交前的敏感信息检查（本地防线）
└── docs/
    ├── SETUP.md             # 部署步骤
    ├── bla-hardening.md     # 反逆向加固：边界、实测、回滚
    └── sensitive-info-guard.md  # 敏感信息防护：预防与清除
```

---

## 本地运行

```bash
# 1. 跑评测，确认脱敏引擎正常
node scripts/eval.js

# 2. 同步（需要 GITHUB_TOKEN）
GITHUB_TOKEN=xxx \
GH_OWNER=你的用户名 \
GH_REPO=pgrefuge-forum \
node scripts/sync.js

# 3. 本地预览
cd site && python -m http.server 8899
# 打开 http://127.0.0.1:8899
```

离线调试（无网络 / 无 token）：

```bash
node scripts/sync.js --offline   # 用 data/.raw-cache.json
```

---

## 数据格式

`data/posts.json`：

```json
{
  "stats": {
    "totalPosts": 4,
    "totalComments": 3,
    "uniqueAuthors": 5,
    "taggedCounts": { "压榨": 1, "人格污蔑": 1 },
    "strategyCounts": { "reduce": 2, "avoid": 2 },
    "withSensitiveHits": 1,
    "firstPostAt": "2026-10-20T03:14:00Z",
    "lastPostAt": "2026-10-23T09:00:00Z"
  },
  "posts": [
    {
      "number": 1,
      "title": "导师让我每天七点到实验室",
      "content": "某老师让我每天早上七点到实验室……",
      "tag": "压榨",
      "strategy": "reduce",
      "alias": "晚风",
      "createdAt": "2026-10-20T03:14:00Z",
      "hitLabels": ["姓名 + 称谓"],
      "commentCount": 2,
      "comments": [
        { "alias": "旧书页", "content": "先找辅导员反映，聊天记录留着。", "reactions": 5 }
      ]
    }
  ]
}
```

**这个文件就是护城河** —— 真实语料 + 真实的脱敏标注，别人拿不到。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 发帖需 GitHub 账号 | GitHub Discussions 要求登录。giscus 模式的评论也需 OAuth 授权 |
| 快速绑定需一个中转服务 | GitHub 的 OAuth 端点无 CORS 头，浏览器无法直连换 token。源码见 `docs/github-relay-worker.js`，部署步骤见 `docs/github-oauth-setup.md`。没部署时自动降级为「粘贴令牌」 |
| 国内访问需代理 | GitHub 境外服务 |
| 冷启动 | 社区产品的固有难题，需要种子内容与氛围运营 |
| 研究院/研究所未覆盖 | 「研究生院」不在机构词表里，属于已知漏检 |
| 分类数上限 25 | GitHub Discussions 的分类数量限制 |

---

## 敏感信息防护

仓库是公开的，且会渲染用户提交的第三方内容 —— 所以「什么能进 git」需要严格约束。

`wrangler dev` 曾在 `docs/.wrangler/` 留下本机状态目录（Cloudflare 边缘节点诊断：
出口 IP、地理位置、运营商 ASN、TLS 握手随机数），被 `git add -A` 带进历史。

**关键事实：删文件不等于删除。** GitHub 上按 SHA 直取 blob 始终有效，
哪怕提交早已从分支历史消失 —— `raw.githubusercontent.com/<owner>/<repo>/<旧SHA>/<路径>`
照样能下到。

现在有三层防线：

| 层 | 位置 | 作用 |
|---|---|---|
| 1 | `.gitignore` | 挡住本机状态目录 |
| 2 | `.githooks/pre-commit` | 挡住手滑（扫暂存区） |
| 3 | `.github/workflows/check-sensitive.yml` | 挡住绕过（服务器端，扫全历史） |

手动检查：

```bash
node scripts/check-sensitive.js           # 当前文件树
node scripts/check-sensitive-history.js   # 整个 git 历史
```

完整说明（含已泄露内容的清除流程）见 [`docs/sensitive-info-guard.md`](docs/sensitive-info-guard.md)。

---

## 发布产物加固（BLA）

Pages 发布的不是 `site/` 源码，而是 `node scripts/harden-site.js` 生成的 `dist/` 加固版
（BLA / Blind LLM Agents，针对 AI 自动化逆向代理投毒与预算爆破）。
REA 暴露分从 78~98 降到 2，代价是站点体积约 3 倍（209 KiB → 629 KiB）。

**边界要说实话**：仓库是公开的，`site/` 源码任何人都能直接读。
这套加固防的是「扒线上站点 / AI 批量还原 JS」，**防不了直接看 GitHub 源码**，
也不承诺对人肉逆向绝对保密。

```bash
node scripts/harden-site.js            # 生成 dist/ 并做符号冲突 / 语法 / 等价校验
node scripts/harden-site.js --dry-run  # 只看计划，不写文件
```

`dist/` 已进 `.gitignore` —— BLA 会注入蜜罐假凭据，提交会（也应该）被敏感检查拦下。
加固失败即中止部署，不会把功能残缺的站点推上线。
完整实测数据、两个踩过的坑与回滚方式见 [`docs/bla-hardening.md`](docs/bla-hardening.md)。

---

## 关联项目

| 项目 | 说明 |
|---|---|
| `pgrefuge-miniprogram/` | 微信小程序版。同一套脱敏规则，客户端预览与服务端一致（37/37 零漂移） |
| `CASE-STUDY.md` | 产品决策复盘：问题定义、6 个关键决策、量化证据、合规调研、复盘 |

两处共用 `scripts/desensitize.js` 的同一份规则定义。
**规则漂移是这类系统最危险的技术债**，所以用自动化测试守住边界。
