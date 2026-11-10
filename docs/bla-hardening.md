# 站点反逆向加固（BLA / Blind LLM Agents）

> 目的：让 AI 自动化逆向代理、批量扒站脚本难以还原线上站点的逻辑。
> 集成日期：2026-11-10 · 工具版本：`bla-agents@3.2.1` · 强度：`balanced`

---

## 0. 先说清楚防护边界（重要）

**这套方案不保证「别人看不到你的源码」，也做不到。**

| 事实 | 说明 |
| --- | --- |
| 本仓库是**公开**的 | `site/*.js`、`scripts/*.js`、`index.html` 源码任何人都能直接在 GitHub 上读，BLA 加固的是**部署产物**，不是源码。 |
| BLA 打击的是 AI 自动化逆向 | 它靠投毒（蜜罐凭据、诱饵 SourceMap）、预算爆破、反调试让 `REA` 之类的分析代理陷入误判或超限。面对有耐心的人肉阅读，客户端代码没有绝对秘密。 |
| 官方立场一致 | BLA 的 `DISCLAIMER.md` 明确写：「no client-side protection scheme can guarantee absolute mathematical secrecy」。 |

**所以这套东西解决的是**：别人打开你的线上站点按 F12、或让 AI 代理批量扒 `*.js` 还原逻辑时，拿到的是被 400+ 个诱饵符号、影子状态机、蜜罐元数据撑爆的产物，而不是干净源码。

**它不解决**：有人去 `github.com/.../blob/main/site/` 读原始文件。

如果你的真实目标是「源码不公开」，那是一个产品决策，不是技术加固能替代的：把仓库转 `private`（但 GitHub Free 私有仓库的 Pages 权益需要确认，且论坛的 Discussions 发帖入口也会跟着关闭），或把核心逻辑移到服务端 / Worker。二者都与「开源、匿名、可自证清白」的论坛定位冲突，需要你本人权衡。

---

## 1. 集成方式

```
site/          ← 干净源码，进 git，可读、可 review
   ↓  node scripts/harden-site.js
dist/          ← 加固产物，.gitignore 忽略，绝不进 git
   ↓  .github/workflows/sync.yml → upload-pages-artifact(path: dist)
GitHub Pages   ← 访客拿到的是加固版
```

- 加固入口：`scripts/harden-site.js`（零项目级 npm 依赖，BLA 按需装到系统临时目录并缓存）
- 部署挂载点：`sync.yml` 在「同步并脱敏」之后、「部署到 Pages」之前执行加固
- 顺序不能反：`sync.js` 每次会重写 `site/posts.json` 和 `site/desensitize.js`，必须先同步后加固

**本地命令**

```bash
node scripts/harden-site.js                 # 加固 + 全量校验 → dist/
node scripts/harden-site.js --dry-run       # 只打印计划，不写任何文件
node scripts/harden-site.js --verify-only   # 只校验已有 dist/
```

可选环境变量：`BLA_VERSION`（默认 `3.2.1`）、`BLA_SEED_NS`（默认 `pgrefuge-v1`）、
`BLA_INTENSITY`（默认 `balanced`，可设 `bankrupt`）、`BLA_CLI`（指向已装好的 `dist/cli.js`）。

---

## 2. 实测结果（2026-11-10，本机 + 真实浏览器）

### 2.1 加固效果与体积

| 产物 | 加固前 | 加固后 | REA 暴露分 |
| --- | ---: | ---: | --- |
| `config.js` | 2.4 KiB | 72.1 KiB | 78 → 2 |
| `desensitize.js` | 118.2 KiB | 204.8 KiB | 98 → 2 |
| `github-client.js` | 14.5 KiB | 91.6 KiB | 98 → 2 |
| `github-bind.js` | 11.5 KiB | 87.8 KiB | 98 → 2 |
| `index.html`（含内联脚本） | 51.3 KiB | 155.8 KiB | 98 → 2 |
| **站点合计** | **约 209 KiB** | **约 629 KiB** | — |

代价：首屏下载量约 3 倍。对国内需代理访问的用户会更慢一点，这是加固的直接成本。

### 2.2 等价性证据

| 验证层 | 方法 | 结果 |
| --- | --- | --- |
| 单文件导出 | Node `vm` 浏览器沙箱（不提供 `require`/`process`/`Buffer`） | 4/4 `window` 导出一致 |
| 脱敏引擎功能 | 7 组文本 × 3 组参数，比对 `desensitize` / `summarize` 完整输出 + 6 张常量表 | 48/48 逐字节一致 |
| 全站真实浏览器 A/B | Edge 157 headless，本地 HTTP server 同时跑原版与加固版 | 标题、全局模块、脱敏结果、按钮、正文 DOM 全一致；两版均 **0 报错** |
| CI 内置三道校验 | 符号冲突 / `node --check` / 沙箱等价 | 全部通过 |

### 2.3 过程中发现并修掉的两个真问题

**① 同 seed 会让 3/4 的脚本直接失效（严重）**

BLA 给每个产物注入形如 `const _interlockSafetyCorpus_1887` 的**顶层**声明，后缀由 seed 决定。
浏览器里多个 `<script>` 共享同一个全局词法环境，用同一个 seed 时第二个脚本就抛：

```
Identifier '_interlockSafetyCorpus_1887' has already been declared
```

第一次全量加固的浏览器 A/B 实测：页面能打开、静态文案正常，但
`PGDesensitize` / `PGGitHub` / `PGGitHubBind` 全是 `undefined` —— **一键绑定和脱敏全部废掉**。

修复：`harden-site.js` 按 `SEED_NS + 相对路径` 为每个产物派生独立 seed，
并内置「跨脚本顶层声明交叉检测」，402 个符号两两比对，任何重叠直接 `exit 1`。
换独立 seed 后浏览器 A/B 完全等价。

**② `desensitize.js` 被 lane-gate 检查误拒**

BLA 报 `Refusing lane-independent gate [independent-lane-and-reduce]`。
它把脱敏引擎的「逐字符扫描 + reduce」误判成授权校验里的独立分道比对。
这不是安全缺陷（本项目没有授权/许可逻辑），属于误报，故只对该文件传
`--allow-lane-independent`，并在脚本里写明原因，不全局放行。

---

## 3. 与现有隐私防线的关系

BLA 会往产物里注入**蜜罐假凭据**（看起来像 API key 的字符串，纯诱饵）。
如果 `dist/` 被提交进 git，`scripts/preflight.js` 的敏感信息检查会命中并拦截提交——
这是预期行为，不是误报。

处理：`dist/`、`.blarc`、`.bla-hardened/`、`.bla-manifest.json` 已加入 `.gitignore`。
`preflight.js` 工作区模式基于 `git ls-files`、暂存区模式基于 `git diff --cached`，
都只看被跟踪/暂存的文件，因此忽略目录天然不会被扫描。

**上层不变**：pre-commit hook、CI 敏感信息检查、历史扫描三层防线全部原样保留。

---

## 4. 失败策略与回滚

- **fail-closed**：加固或任一校验失败 → 脚本 `exit 1` → workflow 失败 → **不部署**。
  宁可这一轮不更新，也不能把「看起来正常但功能全废」的站点推上线。
  代价是 BLA 的 npm 包临时不可用时部署会跳过（旧版站点仍在线，不会白屏）。
- **立即回滚**：把 `sync.yml` 里 `path: dist` 改回 `path: site`，
  并删掉「反逆向加固站点产物」那一步，push 后下次同步即恢复原版部署。
- **换一批诱饵**：改 `BLA_SEED_NS`（如 `pgrefuge-v2`）重新加固即可，
  无需改任何业务代码。

---

## 5. 尚未覆盖 / 后续可选

- **微信小程序**（`pgrefuge-miniprogram/`）**未接入**。小程序 JS 走的是微信自己的模块化运行时，
  BLA 注入的顶层声明行为与浏览器不同，需单独做真机等价验证后再接。
- **`site/posts.json`** 是公开数据，不加固（也没有可保护的逻辑）。
- 若将来把站点改成 Vite/Rollup 构建，可改用官方 `blaVitePlugin` 在构建阶段直接加固，
  比现在「后处理 5 个文件」更贴合 BLA 的设计假设。
- `bankrupt` 强度尚未在本项目做等价实测；上调前务必先跑
  `BLA_INTENSITY=bankrupt node scripts/harden-site.js` 并做一次浏览器 A/B。

---

## 6. 参考

- BLA 官方仓库：`qybaihe/bla` · npm：`bla-agents`
- 本地参考副本：`G:/clus_4_t/skills/bla-main`（含 `DISCLAIMER.md`、`docs/cli-and-mcp.md`、
  `.agents/skills/blind-llm-agents/SKILL.md`）
- 加固脚本：`scripts/harden-site.js` · 部署挂载：`.github/workflows/sync.yml`
