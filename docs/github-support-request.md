# 给 GitHub Support 的清理请求

> 这封信要提交到 <https://support.github.com/contact> → Category 选 **Data Privacy / Other** 或
> **Repository Support / Something else**。
>
> **提交前请把「私密信息」段落里的方括号占位替换成真实值**，尤其是仓库 URL 和联系方式。
> 信里**不要**写出具体的 IP、城市、运营商名称 —— 描述性质即可（见下方说明）。

---

## Subject（标题栏）

```
Please run garbage collection to purge unreachable objects — sensitive data in rewritten history
```

---

## Body（正文）

```
Hello GitHub Support,

I need to request garbage collection on a public repository to purge unreachable
objects that remain accessible by SHA after a history rewrite.

## Repository

  Owner:  m34571581-blip
  Repo:   pgrefuge-forum
  URL:    [在此填完整仓库 URL]
  Current main HEAD: ffe191fb4672088e47deb66af2b301a98316145d

## What happened

On 2026-11-07, a local development tool (Cloudflare's `wrangler dev`) left behind
a state directory under `docs/.wrangler/` in my working tree. That directory
contains local runtime diagnostics, and I committed it accidentally with
`git add -A` before noticing.

The committed files include Cloudflare edge-node diagnostics containing:

  - The egress IP address of the machine that ran the tool
  - Geolocation of that IP (city, region, country)
  - The network operator / ASN and organization name
  - A TLS handshake random value from the local connection
  - Empty local SQLite state databases and source-map bundles

This is not a credential leak — there are no tokens, keys, or passwords in those
files. It is network-environment information that should not be publicly
discoverable. I am therefore **not** requesting any credential rotation; a
garbage collection is the only remedy needed.

## What I have already done

1. Rewrote history with `git filter-repo`:
   - Removed the entire `docs/.wrangler/` path from every commit
   - Replaced the egress IP literal with a placeholder in both file contents
     and commit messages
2. Force-pushed the rewritten history to `main`.
3. Deleted and recreated the `main` branch via the Git API (the default branch
   cannot be deleted directly) so that no ref points at the old commits.
4. Verified there are no remaining references that could pin the old objects:
   - Branches: 1 (`main` only)
   - Pull requests: 0
   - Tags: 0
   - Forks: 0
   - No other refs returned by `GET /repos/{owner}/{repo}/git/matching-refs/`
5. Confirmed the local repository no longer contains the objects
   (`git cat-file -t <old-sha>` reports "Not a valid object name").
6. Verified the rewritten history byte-for-byte matches the original working
   tree except for the intended placeholder substitutions.

## The problem

The old objects are still served by GitHub. Note that **different API endpoints
are at different stages of cleanup**, which is why I am listing each one
separately:

  GET /repos/m34571581-blip/pgrefuge-forum/git/trees/9366480?recursive=1
    → HTTP 200, returns 99 tree entries (52 of them under docs/.wrangler/)

  GET /repos/m34571581-blip/pgrefuge-forum/git/commits/ceb9a5a509ea9ffc6b2943794218c6838788c105
    → HTTP 200, returns the commit object

  GET /repos/m34571581-blip/pgrefuge-forum/git/commits/936648099d0748e8834cb65e8234b138b9e58be3
    → HTTP 404 Not Found  (this one appears to be already collected)

  https://raw.githubusercontent.com/m34571581-blip/pgrefuge-forum/9366480/docs/.wrangler/cache/cf.json
    → HTTP 200, returns the file contents

The full SHA of the offending commit is:

  936648099d0748e8834cb65e8234b138b9e58be3

The commit that removed it was:

  ceb9a5a509ea9ffc6b2943794218c6838788c105

I understand GitHub does not expose a user-triggered GC endpoint — I tried
`POST /repos/{owner}/{repo}/git/gc` and it returns 404, which is expected.

## Request

Could you please run garbage collection / expire unreachable objects on this
repository, so that the objects reachable only from the pre-rewrite history
are no longer served?

I understand this may be handled by the background GC scheduler, but I would
appreciate it if you could trigger it manually, since this is a public
repository and the affected files are network-environment data that should not
remain downloadable.

## Verification I will run afterwards

  # Should return 404 (currently 200)
  curl -s -o /dev/null -w "%{http_code}" \
    "https://raw.githubusercontent.com/m34571581-blip/pgrefuge-forum/9366480/docs/.wrangler/cache/cf.json"

  # Should return 404 (currently 200)
  curl -s -o /dev/null -w "%{http_code}" \
    "https://api.github.com/repos/m34571581-blip/pgrefuge-forum/git/trees/9366480?recursive=1"

I am looking for 404 (or an equivalent "not found") rather than 200.

## Contact

  [在此填你的邮箱]
  [如有需要，可附上身份验证说明]

Thank you for your help.

Best regards,
m34571581-blip
```

---

## 提交前请检查这几项

| 项 | 说明 |
|---|---|
| **仓库 URL** | 信里是 `[在此填完整仓库 URL]`，要替换 |
| **联系方式** | `[在此填你的邮箱]` 要替换。GitHub 会用它回复你 |
| **不要写出敏感值本身** | 信里只描述「有出口 IP、地理位置、运营商名称」，**不写具体值**。理由：Support 工单系统本身也是外部服务，把敏感数据再抄一遍等于扩大暴露面。而支持只需要知道「有这类数据 + 在哪些路径上」就能定位清理 |
| **提交分类** | 选能提到 "privacy" / "sensitive data" 的分类。这封信的核心诉求是隐私清理，不是功能问题 |

### 为什么信里要逐个列出端点

实测发现 **GitHub 各个 API 端点的回收进度不一致**：

| 端点 | 状态 |
|---|---|
| `/git/commits/9366480...` | **已 404**（这个提交对象已被回收） |
| `/git/trees/9366480...` | 仍 200，含 99 个 tree 条目 |
| `/git/commits/ceb9a5a...` | 仍 200 |
| `raw.githubusercontent.com/.../cf.json` | 仍 200 |

这说明 GitHub 的 GC 是**逐对象**回收的，不是整批下线。
只给支持一个「旧 SHA」他们可能查完发现 commit 已经 404 就以为处理好了 ——
但 tree 和 raw 链接还能拿到数据。把每个端点都列出来，能避免这种「查了说是好的」的情况。

## 补充说明：为什么不能只靠等

GitHub 的后台 GC 是异步的，官方社区的说法是几小时到几周（视仓库活跃度）。
在这段时间里，被删的文件仍然能通过 `raw.githubusercontent.com` 按旧 SHA 下载 ——
**「已经删了」不等于「已经不可访问」**。

我已经把所有可能的引用都清断了（1 branch / 0 PR / 0 tag / 0 fork），
剩下唯一缺的就是服务端把不可达对象真正回收掉。
