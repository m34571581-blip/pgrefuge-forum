/**
 * 论坛站点配置
 *
 * 单独成文件，改这里不用动 index.html。
 *
 * 关于 category 与 categorySlug：
 *   category      —— 分类的「显示名」，同步脚本按它筛帖子
 *   categorySlug  —— 分类的「URL slug」，拼发帖链接用
 *
 * 两者不一定相同：ASCII 分类的 slug 是小写转写（General → general），
 * 中文分类则由 GitHub 转成拼音（经历 → jingli）。
 * 所以显示名和 slug 要分开配，别想当然。
 *
 * slug 可以从 GitHub 拿到（同步脚本会自动写进 posts.json 的 stats.categorySlug），
 * 这里填的是兜底值 —— 万一还没同步过，链接也不能指错地方。
 */
window.PG_CONFIG = {
  // GitHub 仓库，格式 所有者/仓库名
  repo: 'm34571581-blip/pgrefuge-forum',

  // Discussions 分类显示名（必须与 GitHub 上建的分类完全一致）
  category: '经历',

  // Discussions 分类 slug（拼 /discussions/new?category= 用）
  categorySlug: 'jingli'
};
