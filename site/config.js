/**
 * 论坛站点配置
 *
 * 单独成文件，改这里不用动 index.html。
 *
 * 关于 category 与 categorySlug：
 *   category      —— 分类的「显示名」，同步脚本按它筛帖子
 *   categorySlug  —— 分类的「URL slug」，拼发帖链接用
 *
 * 对中文分类来说，GitHub 不做拼音转写，slug 就等于显示名本身
 * （「经历」的 slug 也是「经历」）。但 ASCII 分类不同：
 * General 的 slug 是 general（小写转写），所以两者不能混用。
 *
 * 同步脚本会从 GraphQL 拿到真实 slug 写进 posts.json 的 stats.categorySlug，
 * 前端优先用它。这里填的是兜底值 —— 万一还没同步过，链接也不能指错地方。
 */
window.PG_CONFIG = {
  // GitHub 仓库，格式 所有者/仓库名
  repo: 'm34571581-blip/pgrefuge-forum',

  // Discussions 分类显示名（必须与 GitHub 上建的分类完全一致）
  category: '经历',

  // Discussions 分类 slug（拼 /discussions/new?category= 用）
  // 实测：中文分类的 slug 等于显示名，即「经历」
  categorySlug: '经历'
};
