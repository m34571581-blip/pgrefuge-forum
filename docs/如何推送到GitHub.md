# 把 PGrefuge 论坛推到 GitHub

> 这份文档回答三个问题：**要上传哪些文件**、**代码在哪里输入**、**推完之后还要做什么**。

---

## 一、代码在哪里输入？

Git 命令要在**命令行窗口**里敲，不是浏览器、不是记事本。

你机器上有三个可选的地方，**任选一个**：

### 方式 A：双击脚本（最省事，推荐）

```
G:\clus_4_t\build_my_skill\pgrefuge-forum\push-to-github.cmd
```

**双击它**，黑窗口会依次问你两个问题（GitHub 用户名、仓库地址），回车用默认值即可。
中途会弹浏览器让你登录 GitHub，授权一次就行。

> 等价于在终端里敲 `node push-to-github.js`，只是省掉你切目录。

### 方式 B：PowerShell / Windows Terminal

按 `Win` 键，输入 `powershell`，回车打开。然后：

```powershell
cd G:\clus_4_t\build_my_skill\pgrefuge-forum
node push-to-github.js
```

### 方式 C：Git Bash

如果你装了 Git for Windows，在开始菜单搜 `Git Bash`：

```bash
cd /g/clus_4_t/build_my_skill/pgrefuge-forum
node push-to-github.js
```

### 方式 D：VS Code 内置终端

用 VS Code 打开 `pgrefuge-forum` 文件夹，按 `Ctrl + ~` 打开终端，再敲：

```bash
node push-to-github.js
```

---

### 如果你想手动敲原始命令

脚本做的事就是下面这四步，你也可以一条条来：

```bash
cd G:\clus_4_t\build_my_skill\pgrefuge-forum

git init -b main
git add .
git commit -m "feat: PGrefuge 匿名论坛初始版本"

git remote add origin https://github.com/你的用户名/pgrefuge-forum.git
git push -u origin main
```

**注意最后一条会弹浏览器登录 GitHub** —— 这是正常的，授权一次之后就再也不会弹。

---

## 二、要上传哪些文件？

一共 **15 个文件**，共 466 KB：

```
pgrefuge-forum/
├── README.md                        仓库首页说明（面试官第一眼看这里）
├── .gitignore                       排除 node_modules 等
├── push-to-github.cmd               一键推送（双击用）
├── push-to-github.js                一键推送（逻辑）
├── .github/
│   └── workflows/
│       └── sync.yml                 每 6 小时自动同步 + 部署 Pages
├── data/
│   ├── posts.json                   生成的数据集（帖子 + 脱敏后内容）
│   └── .raw-cache.json              同步缓存（已加入 .gitignore，不上传）
├── docs/
│   ├── SETUP.md                     部署指南
│   └── images/
│       ├── forum-list.png           论坛列表页截图
│       └── forum-detail.png         论坛详情页截图
├── scripts/
│   ├── desensitize.js               脱敏引擎（从小程序抽出，两边共用）
│   ├── sync.js                      同步管道：拉取 → 脱敏 → 匿名化
│   └── eval.js                      评测脚本（37 条样本 + 跨项目一致性）
└── site/
    ├── index.html                   论坛前端
    ├── config.js                    配置（改仓库名只动这里）
    └── posts.json                   前端读取的数据副本
```

我已经打好了压缩包：**`PGrefuge-forum-github上传包.zip`**（在项目根目录）。

### 备用方案：网页端拖拽上传

如果你完全不想碰命令行：

1. 打开 https://github.com/new
2. Repository name 填 `pgrefuge-forum`
3. 选 **Public**（公开，才能用免费 Pages 托管）
4. **不要勾** "Add a README file"（本地已经有了，会冲突）
5. Create repository
6. 上传页面上传那个 ZIP —— ⚠️ GitHub 网页端**不支持直接传 ZIP**，需要先解压，把 `pgrefuge-forum` 文件夹里的内容拖进去

拖拽时注意：拖**文件夹内容**，不是拖 `pgrefuge-forum` 这个文件夹本身。
`.github` 是隐藏目录，网页端可能不显示 —— 这时改用命令行方式，或者在仓库 Settings 里手动建 workflow。

---

## 三、推送前必须知道的一件事

**GitHub 上的仓库名和分类名必须完全一致。**

| 位置 | 必须写成 |
|---|---|
| 仓库名 | `pgrefuge-forum` |
| Discussions 分类名 | `经历`（中文，两个字） |
| `site/config.js` 的 `repo` | `你的用户名/pgrefuge-forum` |

脚本会自动帮你改 `config.js`。但**分类名「经历」得你手动建**，写错一个字同步就拉不到数据。

---

## 四、推送成功后还要做 3 件事

脚本会提示你，这里再说一遍：

### 1️⃣ 开启 Discussions

仓库页 → 右上角 **Settings** → 左侧 **General** → 拉到最下
勾选 **Discussions** → Save

### 2️⃣ 建分类「经历」

仓库页顶部 **Discussions** 标签 → 右侧 **New category**
名字填 `经历`，描述随便写 → Create

### 3️⃣ 开 Pages 并跑一次同步

- **Settings** → 左侧 **Pages** → Source 选 **GitHub Actions**
- 顶部 **Actions** 标签 → 左侧选 **PGrefuge Sync** → 右侧 **Run workflow** → 确认

跑完约 1–2 分钟，站点就上线了：

```
https://你的用户名.github.io/pgrefuge-forum/
```

---

## 五、第一次发帖

Discussions 分类建好之后：

- **发帖**：Discussions → New discussion → 选「经历」分类
  - 标题写 `[压榨] 你的标题`（方括号里是标签，同步脚本会识别）
  - 正文第一行写 `> 策略: reduce`（reduce=硬刚回去 / avoid=忍一忍 / transfer=找人帮忙 / escape=溜之大吉）
- **评论**：在帖子里回复。脚本会把 GitHub 用户名转成诗意代号（「晚风」「山雀」），原用户名不会出现在公开页面上

**冷启动提醒**：空论坛会死。每条评论都要认真回 —— 社区的死亡往往不是没人发帖，是没人回应。

---

## 常见问题

**Q：推送时提示 `could not read Username` 或 `Authentication failed`？**
A：浏览器登录没完成。手动打开 https://github.com 登录一次，再重跑脚本，弹出授权窗口时点 Authorize。

**Q：提示 `does not appear to be a git repository`？**
A：GitHub 上还没建这个仓库。按上面「网页端拖拽上传」的第 1–5 步先建仓库。

**Q：站点打开是空白 / 显示「数据还没同步」？**
A：还没跑第 3 步（Run workflow），或者分类名不是「经历」。Actions 页面能看到同步日志。

**Q：想要「每个人都��发经历」，但 GitHub 要登录？**
A：这是 GitHub Discussions 的硬性要求（已核实官方文档）。换取的是：零服务器成本、零备案、数据完全归你、审核直接在 GitHub 侧做。对「收集真实语料」这个目标来说划算。

**Q：国内访问慢 / 打不开？**
A：GitHub 是境外服务，国内访问有延迟。这是「零成本」换来的代价。

---

## 跑完之后

论坛有真实数据后，回到作品集（`portfolio/index.html`）的「真实运行数据」章节会**自动更新** —— 指标卡是从论坛 live 拉取的，不是写死的数字。

记得把 `site/config.js` 的 `repo` 改成真实用户名后**重新跑一次同步**，作品集才能读到你的数据。
