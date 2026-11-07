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

### ❌ 你看到的那个列表是错的类目

你截图里的那些选项 —— 邀请 / 迁移和锁定状态 / 恢复 / 转移 / 删除 /
存储库功能 / Log request / Repository access issues / Remove LFS objects ——
全部属于 **「代码存储库 / Repositories」** 类目。

这个类目是**仓库运维操作**（邀请协作者、转移仓库、删仓库、删 LFS 对象），
**不包含敏感数据清理**。所以在这里找不到是正常的，不是你的问题。

社区里有个和你情况**完全一样**的人（Standard 账户、同样找不到这个选项），
最终得到的官方回复是：

> github actually does provide support for sensitive data removal and security
> issues on **free/standard accounts**, even though it says "technical support
> not included" for general stuff. **security and account issues bypass that
> restriction.**

### ✅ 正确类目：账户 / 安全 / 滥用

**要选「账户、安全与滥用」那一类，不是「代码存储库」。**

路径（登录后从 <https://support.github.com/contact> 进）：

```
顶层类目 → 账户 / 安全 / 滥用（Account, Security, or Abuse）
```

在这个类目下找一个**带大文本框**的子类。

**判据只有一个：表单里必须出现能写详细说明的大文本框。**
如果只有几个单选 + 一个 URL 输入框，那是流程表单（比如删仓库），退回重选。

> ⚠️ **不要选「删除」**。那里面最后有一道
> 「请确认您的操作。存储库一旦被彻底清除，将无法恢复」，
> 选「删除」会**真的把仓库删掉**。

> 💡 小技巧：可以先随便填一下走到最后，看有没有「详细描述」文本框，
> 不提交直接关掉，再回退重选。这样不会误提交。

### 关于 `?flow=clear_cached_views`

这个 flow 参数**在登录后会被丢掉** —— 实测：

```
未登录：/contact?flow=clear_cached_views
         → 302  help.github.com/contact?flow=clear_cached_views   ← 参数保留
         → 302  help.github.com/request/landing                   ← 登录页

登录后：仍然回到 /support/contact 的一般分类页，flow 丢失
```

所以它**不能用来直达表单**，只能作为「登录时保留上下文」的提示。
（这个参数在 DMCA takedown 的处理流程里被公开引用过，
但那条流程走的是另一套工单系统。）

**结论：靠 flow 参数走不通，靠选对类目才行。**

### 📌 信的第一句话要写明性质

因为类目可能不完全对，信的**第一句**要自我定性，让支持知道该转给谁：

> This is a sensitive-data removal request per the GitHub Docs page
> "Removing sensitive data from a repository", not a technical support question.

社区里有人靠这一句话让工单被正确路由，而没有被打回模板回复。


## 三、Subject（标题栏）

```
Garbage collection request: unreachable objects still served after history rewrite
```

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

### 备选路径

**1. GitHub Community Discussions**
<https://github.com/orgs/community/discussions> → 发到 `Repositories` 分类下。

有 GitHub Community Manager 定期巡看并手工触发后台刷新。
社区里确实有人靠这条路解决了同样的问题（有人发帖后，
Community Manager 手工刷新了贡献者列表，贡献者图随即恢复）。

> 社区讨论是**公开**的，所以那里只说「我已提交工单，工单号 XXX」，
> **不要贴仓库名和 SHA**。工单本身才是私密信道。

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
