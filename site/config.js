/**
 * 论坛站点配置
 *
 * 单独成文件，改这里不用动 index.html。
 *
 * 关于 category 与 categorySlug：
 *   category      —— 分类的「显示名」，同步脚本按它筛帖子
 *   categorySlug  —— 分类的「URL slug」，拼发帖链接用
 *
 * 命名约定：**技术参数一律用英文**。
 * 分类名、slug、环境变量值这些要出现在命令行、URL、配置里的东西，
 * 用英文可以避免编码问题（中文分类名要 URL 编码，容易出错），
 * 也让日志和排查更直观。
 * 中文只保留在面向用户的界面文案里（「写经历」「你的处境」这些）。
 *
 * category 与 categorySlug 的关系：
 *   - ASCII 分类，slug 是小写转写（General → general）
 *   - 中文分类，GitHub 不做拼音转写，slug 等于显示名本身
 * 所以两者分开配，不假设它们相等。
 *
 * 同步脚本会从 GraphQL 拿到真实 slug 写进 posts.json 的 stats.categorySlug，
 * 前端优先用它。这里填的是兜底值 —— 万一还没同步过，链接也不能指错地方。
 */
window.PG_CONFIG = {
  // GitHub 仓库，格式 所有者/仓库名
  repo: 'm34571581-blip/pgrefuge-forum',

  // Discussions 分类显示名（必须与 GitHub 上建的分类完全一致）
  category: 'experiences',

  // Discussions 分类 slug（拼 /discussions/new?category= 用）
  categorySlug: 'experiences'
};
