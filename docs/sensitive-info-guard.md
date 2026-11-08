# 敏感信息泄露：预防与清除

> 这份文档记录一次真实事故 —— `wrangler dev` 留下的本机状态目录被提交进 git 历史，
> 里面有 Cloudflare 边缘节点诊断数据（出口 IP、地理位置、运营商 ASN、TLS 握手随机数）。
> 全文都是实测结论，不是推测。

---

## 一、结论先行

**删文件不等于删除。**

GitHub 上按 SHA 直取 blob 始终有效，**哪怕那个提交早就从分支历史里消失了**：

```
https://raw.githubusercontent.com/<owner>/<repo>/<旧SHA>/<路径>
```

实测：force push 之后旧提交页仍返回 200，`raw` 链接照样能下到文件。
所以「发现后 git rm 掉」是不够的 —— 必须重写历史 + 断开所有引用 + 等服务端 GC。

**唯一可靠的防线是入库前拦截。** 事后补救的代价高一个量级。

---

## 二、三层防线

### 第 1 层：`.gitignore` —— 挡住本机状态目录

这些是「这台机器/这个账号的运行时状态」，不是项目代码：

```
.wrangler/     # Cloudflare Workers 本机状态 ← 本次事故的源头
.dev.vars       # Cloudflare 本地密钥
.netlify/  .vercel/  .firebase/  .cache/
.env  *.pem  *.key
*.sqlite  *.sqlite-shm  *.sqlite-wal
```

**踩坑提示**：`wrangler dev` 会在**当前工作目录**下建 `.wrangler/`，不是仓库根。
在 `docs/` 里跑就会生成 `docs/.wrangler/`。

### 第 2 层：pre-commit hook —— 挡住手滑

```bash
git config core.hooksPath .githooks
```

hook 只扫暂存区，快到可以每次提交都跑。
可以用 `git commit --no-verify` 跳过 —— 所以还需要第 3 层。

### 第 3 层：CI workflow —— 挡住绕过

`.github/workflows/check-sensitive.yml`，push / PR 都触发。

与 hook 的本质区别：hook 是**本地**的（能被跳过、能不触发），
CI 是**服务器端**的（无论从哪推都会跑）。

关键配置：`fetch-depth: 0` —— 只查当前文件树会漏掉「已删除但仍在历史里」的内容。

---

## 三、扫描脚本

### `scripts/check-sensitive.js` —— 当前文件树

```bash
node scripts/check-sensitive.js              # 扫已跟踪文件
node scripts/check-sensitive.js --staged     # 只扫暂存区（hook 用）
node scripts/check-sensitive.js --dir <路径> # 扫指定目录
node scripts/check-sensitive.js --strict     # 公网 IP 也当错误
```

**检测三类**：

| 类别 | 内容 |
|---|---|
| 凭据 | GitHub PAT（fine-grained / classic / oauth / app / refresh）、WorkBuddy publishable key、Cloudflare token、Google / Slack / npm / Anthropic / OpenAI API key、私钥、Authorization 头、通用 `api_key` / `secret` 赋值 |
| 本机环境 | Cloudflare 边缘诊断字段、TLS 握手随机数、ASN、地理位置字段、`162.159.x.x` 出口 IP |
| 路径黑名单 | `.wrangler/`、`.env`、`.dev.vars`、`node_modules/` 等 |

**公网 IP 单独处理**：内网与回环地址排除（`127.0.0.1` / `10.x` / `192.168.x` /
`172.16-31.x` 不指向具体机器），默认只警告不阻断 —— 文档里写个代理地址是正常内容，
天天误报的话没人会看检查结果。

### `scripts/check-sensitive-history.js` —— 整个 git 历史

```bash
node scripts/check-sensitive-history.js
```

遍历全部历史 blob + 提交信息。路径黑名单在历史里出现也报 ——
因为 `git rm --cached` 删掉文件后，它仍能在历史里被翻出来。

---

## 四、两个真实的设计缺陷（都是被 CI 抓出来的）

CI 连续两次失败，抓到的都是我自己写的提交信息。但这暴露了两个真实缺陷：

### 缺陷 1：提交信息不该扫环境字段

提交信息里提到字段名、写规则示例是正常的说明文字：

```
我们检查了 tlsClientRandom 字段
"tlsClientRandom"\s*:\s*"[^"]{8,}"  ← 加值要求
```

环境字段的泄露风险在**文件内容**里（`cf.json` 是当文件提交的），提交信息只是描述。
凭据则相反 —— token 出现在提交信息里就是真泄露。

→ **提交信息只扫凭据类，环境字段只扫文件内容。**

### 缺陷 2：规则示例会命中自己

文档 / 注释里写「违规的写法长这样：`"tlsClientRandom": "xGPITqo6K..."`」  pgrefuge:allow-sensitive
必然会被规则命中。逐个加豁免太啰嗦，所以约定显式标记：

```
# 行末加 pgrefuge:allow-sensitive → 扫描器跳过这一行
```

豁免是**显式**的，每加一个都要有人判断过 —— 滥用豁免等于关掉检查。

### 附带的规则修正

环境字段要求「字段名 + 冒号 + 非空值」同时出现，纯提及字段名不报：

```js
/"tlsClientRandom"\s*:\s*"[^"]{8,}/
/"asOrganization"\s*:\s*"[^"]{3,}/
/"(city|region|country|latitude|longitude)"\s*:\s*"[^"]+/
```

**验证规则没被改弱**：用真实污染数据（从被泄露的 `cf.json` 抄的实际值）重测，
4 处全部命中。

---

## 五、清除已泄露内容的完整流程

这是本次事故实际走过的流程，可直接复用。

### 第 1 步：先全面扫描，别急着动手

```bash
node scripts/check-sensitive-history.js
```

### 第 2 步：备份 + 记录回滚点

```bash
cp -r <repo> <repo>-backup-$(date +%Y%m%d)
git rev-parse origin/main    # 记下来
```

force push 是不可逆操作，必须有回滚点。

### 第 3 步：写替换规则

`git-filter-repo` 的规则文件语法：

```
# 替换文本
162.159.110.174==><被限流的出口 IP>  pgrefuge:allow-sensitive

# 正则（加 regex: 前缀）
regex:\b1\.2\.3\.4\b==><IP>
```

### 第 4 步：重写历史

```bash
pip install git-filter-repo

# 删目录 + 替换 blob 内容 + 替换提交信息
git filter-repo --force \
  --invert-paths --path docs/.wrangler/ \
  --replace-text <替换规则> \
  --replace-message <替换规则>
```

> `git-filter-repo` 会**移除 origin remote**（防误推），记得重新 `git remote add origin ...`

**验证重写没误伤**：

```bash
# 与备份逐文件对比（内容差异，不含 SHA 变化）
diff -rq --exclude=.git <repo>-backup <repo>
```

本次只有 `github-relay-worker.js` 一个文件有差异（IP 被替换），其余 40 个逐字节一致。

### 第 5 步：force push

```bash
git push --force-with-lease=main:<旧SHA> origin main
```

`--force-with-lease` 的期望值要用**远端当前**的 SHA，不是本地最老的提交。

### 第 6 步：断开所有引用（关键，容易漏）

旧对象还在服务器上的原因，是**还有 ref 指向它**。要清掉：

- ✅ 所有其他分支 → 删
- ✅ 所有 tag → 删
- ✅ **所有 PR** → `refs/pull/*/head` 会 pin 住旧对象，**必须关闭或合并**
- ✅ 所有 fork → 别人的 fork 也持有旧对象

**不能直接删默认分支**（GitHub 返回 `Cannot delete the default branch`）。
要先切走再删：

```bash
# 1. 建临时分支（指向同一个 SHA）
POST /repos/{owner}/{repo}/git/refs   {"ref":"refs/heads/gc-temp","sha":"<SHA>"}
# 2. 把默认分支切过去
PATCH /repos/{owner}/{repo}             {"default_branch":"gc-temp"}
# 3. 现在能删 main 了
DELETE /repos/{owner}/{repo}/git/refs/heads/main
# 4. 用同一个 SHA 重建 main（内容零变化）
POST /repos/{owner}/{repo}/git/refs   {"ref":"refs/heads/main","sha":"<SHA>"}
# 5. 默认分支切回 main
PATCH /repos/{owner}/{repo}             {"default_branch":"main"}
# 6. 删临时分支
DELETE /repos/{owner}/{repo}/git/refs/heads/gc-temp
```

### 第 7 步：等 GitHub 后台 GC，或联系 Support

**GitHub 没有手动触发 GC 的按钮或 API。** 实测确认：

| 尝试 | 结果 |
|---|---|
| `POST /repos/{owner}/{repo}/git/gc` | 404（端点不存在） |
| 删分支重建 | 断开了引用，但对象仍在 |
| 等待后台 GC | 几小时到几周（视仓库活跃度） |

**GC 完成前，旧 SHA 依然能下载到文件。** 这段时间要当作「仍然泄露」处理。

#### 联系 Support 时官方要求提供什么

GitHub 官方《Removing sensitive data from a repository》明确要求提供：

| 项 | 说明 | 本次的值 |
|---|---|---|
| Owner / Repo | 仓库标识 | `m34571581-blip/pgrefuge-forum` |
| **First Changed Commit(s)** | 验证你确实做过重写的凭据 | `7cfef8b9637378e41ca0951534e76c7a3acc5d02` |
| 受影响的 PR 数量 | 同上 | `0` |
| LFS orphan 对象 | 有的话要附文件 | 无 |

> **First Changed Commit 从哪来**：`git filter-repo` 输出里的
> `NOTE: First Changed Commit(s)`。**这个值要当场记下来** ——
> 重写完它就很难找了（历史已变，只能靠新旧历史对比反推：
> 找出新历史里最早、且不在旧历史里的那个提交）。
> 本次就是因为脚本没记录这一项，后来靠 GitHub API 逐个比对两版历史才定位出来。

**⚠️ 表单类别别选错**：Support 的表单按分类动态生成。
「删除代码存储库」那个分类是**删整个仓库**的（最后有「请确认您的操作」，
选「删除」不可恢复）。
判据是**表单里必须有大文本框能写详细说明**；只有单选 + URL 输入框的是流程表单。
免费账户的最终可选路径见本节末尾「提交入口」的结论——顶层「登录问题」，
不要按早期的 `Repositories → Something else / Other` 去找（该选项在 fpt 账户不存在）。

#### 关键：Support 只受理「敏感数据」

官方同一篇里写着：

> GitHub Support won't remove non-sensitive data, and will only assist in
> the removal of sensitive data in cases where we determine that the risk
> can't be mitigated by rotating affected credentials.

所以信里**必须论证「为什么这算敏感」**，不能只说「我误提交了文件」。

判断标准：
- 是密钥？→ 敏感，但要说明已吊销/轮换（因为轮换了就够了的，官方不建议折腾历史）
- 是无法吊销的东西？→ **敏感**。比如出口 IP + 地理位置 + ISP ——
  这些没法轮换，除了从存储里删掉没有别的缓解手段。
  这正对应官方说的 "risk can't be mitigated by rotating affected credentials"。

#### Support 收到后会做什么

官方列的四件事：

> - Dereference or delete any affected pull requests on GitHub
> - **Run a garbage collection on the server to expunge the sensitive data from storage**
> - **Remove cached views**
> - If LFS Objects are involved, delete and/or purge the orphaned LFS objects

#### 提交入口：选对类目 + 选对子项

**顶层选「登录问题」** —— 这是 fpt（免费/标准）账户唯一开放受理的队列。

**官方权益表**（About GitHub Support）：

| 计划 | GitHub Community | Standard support | Enterprise support | Premium support |
|---|---|---|---|---|
| **Free user** | ✓ | ✗ | ✗ | ✗ |
| Pro / Team | ✓ | ✓ | ✗ | ✗ |

免费账户只有第一列 ✓。同一篇紧接着写：

> To report **account, security, and abuse issues**, or to receive assisted
> support for a paid account, visit the support portal.

**「仓库」类目下的子项（模板/版本/见解/分支等）属于 Standard support 那一列
—— 对免费账户是 ✗，工单多半被自动关闭。**

另一条重要说明：
> For security-related matters, all communication is handled in writing through
> support tickets. This includes... **credential exposure**.

即敏感数据暴露走工单受理，**且只走书面**（不会回电）。

中文版同段：「你仍然可以联系 GitHub 支持以报告**帐户、安全和滥用问题**」。

**「仓库」类目下的子项全是流程表单**（实测）：

| 子项 | 形态 | 能用吗 |
|---|---|---|
| 删除 | URL 输入 + 「请确认您的操作」 | ❌ 会真删仓库 |
| 存储库功能 | 复选框：模板/版本/见解/分支 | ❌ 都不匹配 |
| Log request | 日志专用 | ❌ |
| Remove LFS objects | LFS 专用 | ❌ |
| 邀请/迁移和锁定状态/恢复/转移 | 各自操作流程 | ❌ |

免费账户的顶层只有 6 个类目
（Copilot / Codespaces / 仓库 / 教育版 / 登录问题 / 计费和付款），
**没有「安全」类目** —— 找不到是账户层级的限制，不是你的问题。

**判据**：表单里必须出现能写详细说明的大文本框。
只有几个单选 + URL 输入框的是流程表单。

⚠️ **绝对不要选「删除」** —— 最后有「请确认您的操作」，
选「删除」会真的删掉仓库。

社区里有个情况完全相同的人（Standard 账户、同样找不到这个选项），
得到的官方回复是：

> github actually does provide support for sensitive data removal and security
> issues on **free/standard accounts**, even though it says "technical support
> not included" for general stuff. **security and account issues bypass that
> restriction.**

所以**免费账户也能提** —— 「technical support not included」只针对常规技术支持。

**判据**：表单里必须出现能写详细说明的大文本框。
只有几个单选 + URL 输入框的是流程表单（比如删仓库），退回重选。

**不要选「删除」** —— 最后一道「请确认您的操作」选「删除」不可恢复。

#### 关于 `?flow=clear_cached_views`

这个 flow 参数**登录后会被丢掉**：

```
未登录：/contact?flow=clear_cached_views
         → 302  help.github.com/contact?flow=clear_cached_views   ← 参数保留
         → 302  help.github.com/request/landing                   ← 登录页

登录后：仍然回到 /support/contact 的一般分类页，flow 丢失
```

它**不能用来直达表单**，只能作为「登录时保留上下文」的提示。
结论：**靠 flow 参数走不通，靠选对类目 + 选对子项才行。**

#### Subject 也要带上「sensitive data」

标题栏也是路由依据。把 "sensitive data removal request" 放在最前面，
比先写 "garbage collection" 更容易被分到正确的团队 ——
后者看起来像技术问题，前者明确指向官方文档里那条专门流程。

#### 免费账户能不能提？

官方《Creating a support ticket》写着只有**付费**账户能看到「提交工单」链接。
但实际案例里免费账户成功过 —— StackOverflow 上有人用同样流程联系 Support，
**5 分钟收到回复**，Support 跑 `git gc` 后链接立刻 404。

所以值得一试。若账号显示「Technical support not included」，
那只是说常规技术支持不包含，不代表敏感数据清理会被拒。

#### 如果工单被自动关闭

社区反馈提到**免费账户的工单有时会被系统自动关闭**（按账户级别路由）。
备选路径：

1. **GitHub Community Discussions** — <https://github.com/orgs/community/discussions>
   发到 `Repositories` 分类下。有 Community Manager 定期巡看并手工触发后台刷新，
   社区里确实有人靠这条路解决了同样的问题。

   按上面的权益表，**免费账户只有这一列是 ✓** ——
   社区讨论对免费账户是官方认可的正式渠道，不是「凑合的替代品」。

   可引用的先例：#190183（How to trigger garbage collection）、
   #209559（Unreachable commit）。

   ⚠️ 那里是**公开**的 —— **不要贴仓库名、用户名、任何 SHA**
   （包括 First Changed Commit）。只说「我已提交工单，工单号 XXX」。
   公开处能说的只有结论层面的技术事实与工单号。
2. **回复确认邮件线程**，不要重复开单 —— 重复单据会拖慢处理。
3. **等后台 GC** — 几小时到几周。

#### 「删仓库重建」是最后手段，不是首选

社区主流建议是**不要删库**：

> don't delete the repo, because Support can run the cleanup on the existing one

理由：删库会连带删掉 wiki、issues、评论、stars、Actions 记录和仓库设置，
而 Support 能在现有仓库上跑 GC，代价小得多。**默认应走这条路。**

但本仓库有两个特殊情况，使删库重建成为可评估的备选：

1. 免费账户的 Support 表单链路反复尝试仍未能稳定提交（见上面六轮修正）；
2. 仓库里没有任何用户内容 —— 实测 issues / PR / discussions / stars /
   forks / releases **全部为 0**，删库只丢 Actions 历史记录与仓库设置，
   后者可由脚本还原。

**⚠️ 三点必须说清楚，不要把推断当结论：**

- 「删库后旧 SHA 立刻 404」**在本仓库未经实测**，属于合理推断。
  脚本会在重建后自动取状态码验证，若仍可访问会明确告警，不谎报成功。
- 一旦仓库里出现真实内容，本方案立刻作废，重新评估。
- 删库需要 `delete_repo` scope；当前 token 只有 `gist, repo, workflow`，
  所以删除动作**必须由本人在网页 Danger Zone 完成**，脚本无法代劳。

**工具**：`scripts/recreate-repo.js`

| 命令 | 行为 |
|---|---|
| `--dry-run` | 只清点与检查，绝不执行任何破坏性操作 |
| `--confirm-delete` | 才真正执行；token 无权限时打印网页删除指引并退出 |
| 网页删完后**重跑同一条命令** | 自动检测到仓库不存在，跳过删除，从「重建」继续 |

执行前自动整目录备份（含 `.git` 全部历史）；重建后还原仓库开关、
Discussions 分类、Pages（workflow 构建）、触发部署，最后验证旧链接。

---

## 六、GitHub 自带的两道防线（已经开着）

仓库的 `security_and_analysis` 配置：

| 功能 | 状态 | 作用 |
|---|---|---|
| `secret_scanning` | enabled | 扫描历史里的凭据，命中会告警 |
| `secret_scanning_push_protection` | enabled | **推送时拦截**含凭据的提交 |

push protection 能挡住大部分常见格式的 token（GitHub PAT、AWS、Slack 等）。
但它**不认识** Cloudflare 边缘诊断这种「非凭据但敏感」的东西 ——
所以自建扫描器仍然必要。

---

## 七、给以后的原则

1. **先想清楚「这个工具会不会在本目录留下状态」**，留下就加进 `.gitignore`。
   别等推上去再补救。

2. **打包交付物时，排除清单要和实际用过的工具链对齐**。
   这次 `node_modules` 想到了，`.wrangler` 没想到 —— 因为之前没用过 wrangler。

3. **本地 `git add -A` 是最危险的操作**。它会把任何工具留下的东西一把带进去。

4. **CI 检查要扫历史，不只是当前文件树。** 只查工作区会漏掉「已删除但仍在历史里」的内容。

5. **扫描器自己会命中自己**。要么自排除，要么提供显式豁免标记 ——
   别让检查规则变成「天天误报然后被忽略」。
