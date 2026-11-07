# 给 GitHub Support 的清理请求

> 提交入口：<https://support.github.com/contact>
>
> **提交前把「私密信息」段落里的方括号占位替换成真实值**（主要是仓库 URL 和邮箱）。
>
> ⚠️ **不要用「删除代码存储库」那个表单** —— 那是删整个仓库的，填了会真删。
> 正确路径见下方「表单怎么选」。

---

## 一、仓库 URL 在哪里找

```
https://github.com/m34571581-blip/pgrefuge-forum
```

三种拿法（任选其一）：

| 方法 | 操作 |
|---|---|
| **浏览器地址栏** | 打开仓库页面，直接复制地址栏的 URL（末尾不要加 `.git`） |
| **git remote** | 在仓库目录执行 `git remote get-url origin`，输出末尾带 `.git`，**去掉后缀**即可 |
| **命令行** | `git config --get remote.origin.url` 同上 |

---

## 二、表单怎么选（重要）

### 你的账户只有 6 个顶层类目

`help.github.com/support/contact/product-selection`（已登录）显示：

| 常用产品 | 情况 |
|---|---|
| Copilot / Codespaces / **仓库** | 教育版 / **登录问题** / 计费和付款 |

社区讨论 #209921 里那个和你情况**完全一样**的人（Standard 账户、
同样找不到敏感数据清理选项、同样想保住仓库不删）看到的也是这六个。
**没有「安全」类目，也没有「Something else」。**

### ⚠️ 已实测：「仓库」下的子项全是流程表单

「我们能提供什么帮助？」是**单选，选不同项则下面整个表单换掉**。
你一路点下来会依次遇到：

| 子项 | 表单形态 | 能用吗 |
|---|---|---|
| 删除 | URL 输入 + 「请确认您的操作」 | ❌ 会真删仓库 |
| 存储库功能 | 复选框：模板 / 版本 / 见解 / 分支 | ❌ 四个都不是我们的场景 |
| Log request | 日志请求专用 | ❌ |
| Remove LFS objects | LFS 专用 | ❌ 本仓库没用 LFS |
| 邀请 / 迁移和锁定状态 / 恢复 / 转移 | 各自的操作流程 | ❌ |

**没有一个是带自由文本框的通用工单表单。**

### ✅ 唯一走得通的路：登录问题

顶层类目里的 **「登录问题」** —— 官方文档明确说明这是免费账户
绕过付费限制的通道：

> If your account uses GitHub Free, you can speak to GitHub users and staff
> on the GitHub Community discussions for most issues, and **you can contact
> GitHub Support to report account, security, and abuse issues.**

中文版同一段：

> 如果未看到此链接，你可以就大多数问题与 GitHub 用户和工作人员在 GitHub
> 社区讨论交谈，**你仍然可以联系 GitHub 支持以报告帐户、安全和滥用问题**。

「账户 / 安全 / 滥用」是 GitHub Support 对免费账户**唯一开放受理**的类别。
敏感数据清理正属于这一类（官方《Removing sensitive data from a repository》
就是让这类请求走 Support）。

**「登录问题」下面通常有「其他 / Other」或直接是描述框**——
选它，然后在描述里说明这实际是数据清理请求。

### 📌 靠正文自我定性（免费账户没有下拉框）

免费账户的表单里**没有**「Type of Issue」这类下拉框
（官方文档源码里那个含 `removing sensitive data (commits, issues,
pull requests, uploaded attachments)` 的选项被包在
`{%- ifversion ghes or ghec %}` 里，只对 Enterprise/Cloud 开放）。

所以 Subject + 正文第一句必须自己说明性质：

Subject:
```
Sensitive data removal request: unreachable objects still served by SHA after history rewrite
```

正文第一句:
```
This is a sensitive-data removal request per the GitHub Docs page
"Removing sensitive data from a repository", not a technical support question.
```

**标题栏也是路由依据** —— 把 "sensitive data removal request" 放最前面，
比先写 "garbage collection" 更容易被分到正确的团队。

### 关于 `?flow=clear_cached_views`

实测**登录后参数会被丢掉**：

```
未登录：/contact?flow=clear_cached_views
         → 302  help.github.com/contact?flow=clear_cached_views   ← 参数保留
         → 302  help.github.com/request/landing                   ← 登录页

登录后：仍然回到 /support/contact 的一般分类页，flow 丢失
```

它**不能用来直达表单**，只能作为「登录时保留上下文」的提示。
**结论：靠 flow 参数走不通，靠选对类目 + 选对子项才行。**


## 三、Subject（标题栏）

```
Sensitive data removal request: unreachable objects still served by SHA after history rewrite
```

**为什么这么写**：标题栏也是路由依据。把「sensitive data removal request」
放在最前面，比先写「garbage collection」更容易被分到正确的团队 ——
后者看起来像技术问题，前者明确指向官方文档里那条专门流程。

---

## 四、Body（正文）

```
Hello GitHub Support,

This is a sensitive-data removal request per the GitHub Docs page
"Removing sensitive data from a repository" — not a technical support question.

I am requesting a server-side garbage collection on a public repository, to
purge unreachable objects that are still being served after a history rewrite.

## Repository

  Owner:  m34571581-blip
  Repo:   pgrefuge-forum
  URL:    [FILL IN REPOSITORY URL]

## First Changed Commit (as required by the sensitive-data-removal procedure)

  7cfef8b9637378e41ca0951534e76c7a3acc5d02

  This is the earliest commit in the rewritten history. Its counterpart in the
  pre-rewrite history was 950063c347479513a2e61293faeaf4628707681b ("Initial
  commit", 2026-10-31). The rewrite changed the hashes of all 55 commits,
  because the rewrite was applied to the whole history rather than a subset.

  Affected pull requests: 0. The repository has never had a pull request
  (verified: GET /repos/m34571581-blip/pgrefuge-forum/pulls?state=all returns
  an empty array). There are also no LFS objects, so no orphaned LFS objects
  need to be purged.

## What was committed accidentally, and why it needs purging

On 2026-11-07 a local development tool (Cloudflare's `wrangler dev`) left a
state directory behind at `docs/.wrangler/` in my working tree. I committed it
by accident with `git add -A`.

The affected files (52 paths in total under `docs/.wrangler/`) include:

  - Cloudflare edge-node diagnostics containing the egress IP address of the
    machine that ran the tool, the geolocation of that IP, the network
    operator / ASN, and a TLS handshake random value
  - Source-map bundles that embed the same IP literal
  - Empty local SQLite state databases

To be clear about severity: there are **no credentials in these files** — no
tokens, no keys, no passwords. I have run a full scan of every blob in the
history and confirmed this. What is exposed is network-environment information:
the egress IP of a residential connection, and the fact that the account
owner is located in a specific city and on a specific ISP.

That information cannot be rotated or revoked the way a credential can, so
there is no mitigation available to me other than removing it from GitHub's
storage. That is why I am filing this request.

## What I have already done

1. Rewrote the history with `git filter-repo`:
   - `--invert-paths --path docs/.wrangler/` to remove the directory from
     every commit
   - `--replace-text` and `--replace-message` to replace the egress IP
     literal with a placeholder, in both file contents and commit messages
2. Force-pushed the rewritten history to `main`.
3. Deleted and recreated the `main` branch through the Git API, because the
   default branch cannot be deleted directly. This ensures no ref points at
   the pre-rewrite commits.
4. Verified there are no remaining references pinning the old objects:
   - Branches: 1 (`main` only)
   - Pull requests: 0
   - Tags: 0
   - Forks: 0
   - `GET /repos/m34571581-blip/pgrefuge-forum/git/matching-refs/` returns
     exactly one ref
5. Verified the local clone no longer contains the objects:
   `git cat-file -t 7cfef8b9637378e41ca0951534e76c7a3acc5d02` reports
   "Not a valid object name" for the pre-rewrite hashes.
6. Verified the rewritten history is byte-for-byte identical to the original
   working tree, except for the intended placeholder substitutions.

## What is still reachable, and why the GC is needed

After the rewrite, the pre-rewrite objects are unreachable from any ref, but
GitHub is still serving them by SHA:

  # Still returns the full tree (99 entries, 52 of them under docs/.wrangler/)
  GET /repos/m34571581-blip/pgrefuge-forum/git/trees/936648099d0748e8834cb65e8234b138b9e58be3?recursive=1
    → HTTP 200

  # Still returns the commit object
  GET /repos/m34571581-blip/pgrefuge-forum/git/commits/ceb9a5a509ea9ffc6b2943794218c6838788c105
    → HTTP 200

  # Still returns the file contents
  https://raw.githubusercontent.com/m34571581-blip/pgrefuge-forum/9366480/docs/.wrangler/cache/cf.json
    → HTTP 200

  # This one has already been collected, which shows the cleanup is partial
  GET /repos/m34571581-blip/pgrefuge-forum/git/commits/936648099d0748e8834cb65e8234b138b9e58be3
    → HTTP 404

The relevant pre-rewrite SHAs are:

  936648099d0748e8834cb65e8234b138b9e58be3   (the commit that introduced the files)
  ceb9a5a509ea9ffc6b2943794218c6838788c105   (the commit that deleted them)

I understand that GitHub does not expose a user-triggered GC endpoint — I
tried `POST /repos/{owner}/{repo}/git/gc` and it returns 404, as expected.

## Request

Could you please run a garbage collection on this repository to expunge these
unreachable objects, and remove the cached views that still serve them?

I understand GitHub's background GC may handle this on its own schedule, but I
would appreciate it if you could trigger it manually, since the affected
files remain downloadable by SHA on a public repository and expose my
network location and ISP.

## How I will verify

  # Currently 200 — I expect 404 after the GC
  curl -s -o /dev/null -w "%{http_code}" \
    "https://raw.githubusercontent.com/m34571581-blip/pgrefuge-forum/9366480/docs/.wrangler/cache/cf.json"

  # Currently 200 — I expect 404 after the GC
  curl -s -o /dev/null -w "%{http_code}" \
    "https://api.github.com/repos/m34571581-blip/pgrefuge-forum/git/trees/936648099d0748e8834cb65e8234b138b9e58be3?recursive=1"

## Contact

  [FILL IN YOUR EMAIL]

Thank you for your help.

Best regards,
m34571581-blip
```

---

## 四、提交前检查清单

| 项 | 说明 |
|---|---|
| **仓库 URL** | 填 `https://github.com/m34571581-blip/pgrefuge-forum`（末尾**不加** `.git`） |
| **邮箱** | 填你能收信的邮箱，GitHub 会用它回复 |
| **First Changed Commit** | 已填好 `7cfef8b9637378e41ca0951534e76c7a3acc5d02` |
| **受影响的 PR 数量** | 已填 `0` —— 官方文档要求提供这个数字，是用来验证你确实做过重写的凭据 |
| **LFS 对象** | 无 —— 官方文档要求若有，需附上 orphan 文件；本仓库没用 LFS，写 0 即可 |
| **不要写敏感值本身** | 信里只描述「有出口 IP、地理位置、运营商名」，**不写具体值**。Support 工单系统本身也是外部服务，把敏感值再抄一遍等于扩大暴露面。而支持定位清理只需要知道类型和路径 |

---

## 五、为什么信里要逐个列出端点

实测发现 **GitHub 各 API 端点的回收进度不一致**：

| 端点 | 状态 |
|---|---|
| `/git/commits/9366480...` | **已 404**（提交对象已回收） |
| `/git/trees/9366480...` | 仍 200，99 个 tree 条目（52 个 wrangler） |
| `/git/commits/ceb9a5a...` | 仍 200 |
| `raw.../cf.json` | 仍 200 |

说明 GC 是**逐对象**回收，不是整批下线。
如果只给一个旧 SHA，支持查完发现 commit 已经 404，可能就以为处理好了 ——
但 tree 和 raw 链接还能拿到数据。逐个列出能避免这种「查了说是好的」的情况。

---

## 六、官方文档对这件事的说明

GitHub 官方《Removing sensitive data from a repository》明确写到：

> you can permanently remove cached views and references to the sensitive data
> in pull requests on GitHub by contacting us through the GitHub Support portal

Support 收到后会做四件事：

> - Dereference or delete any affected pull requests on GitHub
> - **Run a garbage collection on the server to expunge the sensitive data from storage**
> - **Remove cached views**
> - If LFS Objects are involved, delete and/or purge the orphaned LFS objects

> **注意**：官方同一篇也写了「GitHub Support won't remove non-sensitive data」。
> 所以信里必须**明确说明为什么这算敏感**（网络位置信息无法轮换/吊销，
> 没有别的缓解手段）—— 这是让支持受理的关键，不能只说「我误提交了文件」。

---

## 七、如果被拒绝或自动关闭

### 官方文档与实际案例不一致

GitHub 官方《Creating a support ticket》写着：

> You will only see the link to open a support ticket if your account uses a
> **paid** GitHub product or you are a member of an organization that uses a
> paid product.

但实际案例里，**免费账户成功过**：

- StackOverflow 上有人用同样的流程（filter-branch + force push）联系 Support，
  **5 分钟就收到回复**，Support 跑了 `git gc` 后链接立刻变 404。
- 社区讨论里也有人说「GitHub support does this manually for users fairly regularly」。

所以结论是：**免费账户也可能被受理**，值得一试。

如果账号显示「Technical support not included」，那只是说**常规技术支持**不包含，
不代表敏感数据清理会被拒 —— 官方文档明确把这类请求归为不同类型处理。

具体到你的账户层级：只有 6 个顶层类目（Copilot / Codespaces / 仓库 /
教育版 / 登录问题 / 计费和付款），没有「安全」类目。
所以走「**仓库 → 存储库功能**」，
不行就换「**登录问题**」（fpt 唯一与账户安全相关的队列）。

### 备选路径

**1. GitHub Community Discussions** ⭐ 最靠谱的兜底
<https://github.com/orgs/community/discussions> → 发到 `Repositories` 分类下。

有 GitHub Community Manager 定期巡看并手工触发后台刷新。
社区里确实有人靠这条路解决了同样的问题（有人发帖后，
Community Manager 手工刷新了贡献者列表，贡献者图随即恢复）。

> ⚠️ 社区讨论是**公开**的 —— 那里**不要贴仓库名、用户名、任何 SHA**。
> 只说「我已提交工单，工单号 XXX」。工单本身才是私密信道。
>
> 公开讨论里能安全说的内容：
> - 结论层面的技术事实（GitHub 对不可达对象的处理机制、GC 是逐对象回收的）
> - 你已经做了哪些清理动作（force push、删分支、删 tag）
> - 工单号
>
> 不能说的：仓库 URL、用户名、旧 SHA、First Changed Commit。

**2. 回复确认邮件而不是重复开单**
工单提交后会收到确认邮件。如果被自动关闭或长时间无回复，
**回复那封邮件的线程**，不要重复开新单 —— 重复单据会拖慢处理。

**3. 等后台 GC**
官方社区的说法是几小时到几周（视仓库活跃度）。
在这期间被删的文件仍能通过 `raw.githubusercontent.com` 按旧 SHA 下载 ——
**「已经删了」不等于「已经不可访问」**，这段时间要当作「仍然泄露」处理。

---

## 八、一个重要提醒：不要删仓库重建

StackOverflow 上有个说法是「删掉仓库重建是最快的办法」，**但那是错的**：

> While the former option is faster, it will also delete the wiki, issues and comments.

删仓库会连带销毁：

- Wiki
- Issues 与评论
- Stars / Watchers / Fork 关系
- Actions 运行记录
- 仓库设置（Discussions 分类、Pages 配置等）

而 Support **可以在现有仓库上跑 GC**，不需要你删它。
社区里也有人明确提醒：「don't delete the repo, because Support can run the
cleanup on the existing one」。

**本仓库有 55 个提交、GitHub Pages 部署、Discussions 数据集** ——
删仓库重建的代价远大于等一次 GC。
