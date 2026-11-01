-- =============================================================================
-- PGrefuge 脱敏引擎 · 服务端同步版
--
-- 与 JS 端（pgrefuge-forum/scripts/desensitize.js）严格同构。
--
-- 本轮新增能力（对应用户反馈「姓名全小写、写全名但没有职称识别不到」）：
--
--   1. 英文姓名任意大小写：Mr.liu / mr. LIU / Ming Liu / ming liu
--   2. 中文姓名无职称：我是王小明 / 王小明让我很痛苦
--   3. 标识符类：学号 / 手机号 / 邮箱 / 社交账号 / 房间号
--
-- PostgreSQL 的正则限制（与 JS 不同，必须绕开）：
--   1. 不支持 \b（词边界）      → 用字符类边界 (^|[^A-Za-z])
--   2. 不支持先行断言 (?!)     → 用捕获边界 ([^A-Za-z]|$)
--   3. CTE 求值顺序不保证       → 全部加 MATERIALIZED 强制顺序
--   4. 不支持命名捕获组         → 用位置参数，但**必须显式编号**
--   5. regexp_replace 只能替换「整个匹配」，不能只替换其中一段
--      → 所以每条规则都必须**匹配完整的待保留片段**，再原样输出
--
-- 英文姓名规则 b1~b6 与 JS 端一一对应：
--   b1  缩写称谓 + 姓     Mr.liu / MR.LIU
--   b2  完整称谓 + 姓     Professor Wang / PROFESSOR liu
--   b2b 姓 + 完整称谓     Liu Professor
--   b3  纯姓形态         Liu is my advisor
--   b4  关系词 + 姓      my advisor Liu
--   b5  全名             Ming Liu
--   b6  英文机构名       Tsinghua University
--
-- 姓氏约束：b1~b5 都要求姓在 en_surname 表里（由 sync-server-dict.py 导入）。
--           这一层是判别力的关键 —— 靠形态判别会误伤 63% 的负样本。
-- =============================================================================

-- ---- 姓名用字词典（由 sync-server-dict.py 自动填充）----
CREATE TABLE IF NOT EXISTS public.name_char (
  ch text PRIMARY KEY
);

-- ---- 英文姓氏词典 ----
CREATE TABLE IF NOT EXISTS public.en_surname (
  s text PRIMARY KEY
);

-- ---- 中文姓氏词典 ----
CREATE TABLE IF NOT EXISTS public.cn_surname (
  s text PRIMARY KEY
);

-- ---- 复姓 ----
CREATE TABLE IF NOT EXISTS public.cn_compound_surname (
  s text PRIMARY KEY
);

-- ---- 常见普通词排除（形似姓名的非人名组合）----
CREATE TABLE IF NOT EXISTS public.name_block_bigram (
  s text PRIMARY KEY
);

-- =============================================================================
-- 辅助函数
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pgrefuge_chr_count(t text, c integer)
RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$
SELECT count(*) FROM generate_series(1, coalesce(length(t), 0)) g(i)
WHERE substr(t, g(i), 1) = chr(c)
$fn$;

-- 判断一个英文词是否在姓氏表里（大小写不敏感）
CREATE OR REPLACE FUNCTION public.pgrefuge_is_en_surname(w text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
SELECT lower(coalesce(w, '')) IN (SELECT s FROM public.en_surname)
$fn$;

-- 判断一个英文「复合姓」（Smith-Jones）是否两段都在姓氏表里
CREATE OR REPLACE FUNCTION public.pgrefuge_is_en_compound(w text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
SELECT NOT EXISTS (
  SELECT 1 FROM unnest(string_to_array(coalesce(w, ''), '-')) AS part
  WHERE NOT public.pgrefuge_is_en_surname(part)
)
$fn$;

-- =============================================================================
-- 主函数
-- =============================================================================
-- 主函数用 plpgsql + EXECUTE 实现，而不是纯 SQL。
--
-- 原因：**PostgreSQL 的 regexp_replace 要求正则必须是编译期常量**。
--   动态拼接的姓氏表（函数返回值）会被当成字面量，
--   导致所有英文姓名规则静默失效 —— 不报错，但一个都不匹配。
--   （实测：regexp_replace('Mr.liu called', pattern || fn(), ...) 无匹配；
--     同样内容硬编码进正则则正常匹配。）
--
-- EXECUTE 的做法：在运行时把姓氏表拼进 SQL 文本，
--   再执行 —— 此时正则就是字面量了，编译期常量约束得到满足。
--
-- 好处：姓氏表仍然是**表**（不是硬编码在函数里），
--   改词典只需 UPDATE 表，不用重新部署函数 —— 从机制上杜绝两端漂移。
CREATE OR REPLACE FUNCTION public.desensitize_detail(p_text text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
AS $fn$
DECLARE
  v_pat text;
  v_text text;
  v_sql text;
  v_res json;
BEGIN
  v_pat := public.pgrefuge_en_surname_pattern();
  v_text := coalesce(p_text, '');

  v_sql := replace(replace($q$
WITH src AS (
  SELECT coalesce(@@TEXT@@, '') AS t
),
p1 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '(我们|他们|其他|某位|哪位|这位|那位|这个|那个|你的|他的|她的|一位|该|各|所有|的|骂|批评|指责|催|逼|卷|折磨|折腾)(老师|导师|副教授|教授|讲师|博士|博导|系主任)',
    '\1' || chr(1) || '\2', 'g') AS t FROM src
),
p2 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '(今天|明天|昨天|前天|后天|上午|下午|晚上|早上|中午|最近|目前|每次|平时|每天|每周|每月|通常|经常|我们|你们|他们|这个|那个|一个|该|隔壁|附近|对面|旁边)(大学|学校|院校|学院|学系|课题组|实验室|科研团队|团队)',
    '\1' || chr(4) || '\2' || chr(4), 'g') AS t FROM p1
),
p3 AS MATERIALIZED (
  SELECT regexp_replace(t, '的', chr(3), 'g') AS t FROM p2
),
p4 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((?:(?!我|你|他|她|它|咱|们|这|那|个|是|去|回|到|达|把|被|给|跟|和|与|但|就|也|还|很|更|不|没|有|找|叫|让|对|从|向|其|之|所|及|或|在|着|过|了|吗|呢|吧|啊|又|再|才|只|最|太|挺|将|已)[一-龥]){1,8})[[:space:]_·・－~～/\\-]*(大学|学校|院校)',
    chr(2) || '某校' || chr(2), 'g') AS t FROM p3
),
p5 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((?:(?!我|你|他|她|它|咱|们|这|那|个|是|去|回|到|达|把|被|给|跟|和|与|但|就|也|还|很|更|不|没|有|找|叫|让|对|从|向|其|之|所|及|或|在|着|过|了|吗|呢|吧|啊|又|再|才|只|最|太|挺|将|已)[一-龥]){1,8})[[:space:]_·・－~～/\\-]*(学院|学系)',
    chr(2) || '某学院' || chr(2), 'g') AS t FROM p4
),
p6 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((?:(?!我|你|他|她|它|咱|们|这|那|个|是|去|回|到|达|把|被|给|跟|和|与|但|就|也|还|很|更|不|没|有|找|叫|让|对|从|向|其|之|所|及|或|在|着|过|了|吗|呢|吧|啊|又|再|才|只|最|太|挺|将|已)[一-龥A-Za-z0-9]){1,12})[[:space:]_·・－~～/\\-]*(课题组|实验室|科研团队|团队)',
    chr(2) || CASE WHEN length(regexp_replace('\1', '[^A-Za-z]', '', 'g')) > 0
                   THEN '___' ELSE '某' END || '\2' || chr(2), 'g') AS t FROM p5
),
-- p7a：姓名 + （称谓）—— 括号整体进匹配范围，替换时丢掉
--      否则「李（老师）」会留下孤儿右括号「某老师）」。
-- p7pre：先去掉称谓后面的右括号
--
-- 为什么需要：PG 的正则里，末尾的 `[[:space:]]*[)）]?` 没能吃掉「老师）」的右括号
--   （实测：(老师)[[:space:]]*[)）]? 能吃掉，但带前缀的完整模式不行）。
--   所以拆成两步：先清掉孤立的右括号，再让 p7a 处理左括号。
p7pre AS MATERIALIZED (
  SELECT regexp_replace(t,
    '(老师|导师|副教授|教授|讲师|博士|博导|系主任)[[:space:]]*[)）]',
    '\1', 'g') AS t FROM p6
),
-- p7a：姓名 + （称谓）—— 括号整体进匹配范围，替换时丢掉
p7a AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((?:(?!我|你|他|她|它|咱|们|这|那|个|是|去|回|到|达|把|被|给|跟|和|与|但|就|也|还|很|更|不|没|有|找|叫|让|对|从|向|其|之|所|及|或|在|着|过|了|吗|呢|吧|啊|又|再|才|只|最|太|挺|将|已)[一-龥]){1,2}?)[（(][[:space:]]*(老师|导师|副教授|教授|讲师|博士|博导|系主任)',
    chr(2) || '某' || '\2' || chr(2), 'g') AS t FROM p7pre
),
p7a AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((?:(?!我|你|他|她|它|咱|们|这|那|个|是|去|回|到|达|把|被|给|跟|和|与|但|就|也|还|很|更|不|没|有|找|叫|让|对|从|向|其|之|所|及|或|在|着|过|了|吗|呢|吧|啊|又|再|才|只|最|太|挺|将|已)[一-龥]){1,2}?)[（(][[:space:]]*(老师|导师|副教授|教授|讲师|博士|博导|系主任)[[:space:]]*[)）]?',
    chr(2) || '某' || '\2' || chr(2), 'g') AS t FROM p6
),
-- p7b：姓名 + 称谓（无括号）
--      与 p7a 分开是因为括号必须**成对**进匹配范围，
--      而「李老师」根本没有括号 —— 用一条带可选括号的正则
--      会让两组括号互相独立，出现孤儿括号。
p7b AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((?:(?!我|你|他|她|它|咱|们|这|那|个|是|去|回|到|达|把|被|给|跟|和|与|但|就|也|还|很|更|不|没|有|找|叫|让|对|从|向|其|之|所|及|或|在|着|过|了|吗|呢|吧|啊|又|再|才|只|最|太|挺|将|已)[一-龥]){1,2}?)(老师|导师|副教授|教授|讲师|博士|博导|系主任)',
    chr(2) || '某' || '\2' || chr(2), 'g') AS t FROM p7a
),
p8 AS MATERIALIZED (
  SELECT regexp_replace(t, '姓(?!(名|别|氏|氏族|名册|名学))([一-龥]{1,2})',
    chr(2) || '姓某' || chr(2), 'g') AS t FROM p7b
),
-- ---- b1: 缩写称谓 + 姓（Mr.liu / MR.LIU / Prof.liu）----
-- 捕获组：1=前边界 2=称谓 3=分隔符 4=姓 5=尾字符
-- ---- 姓氏过滤辅助 ----
--
-- PG 的 regexp_replace 没法在替换里查表，所以「姓必须在姓氏表里」
-- 这个约束只能**分两步**做：
--   1. 宽松正则先把候选替换成「<M>Someone<M>」的标记形式
--   2. 再把**不在姓氏表里**的那些还原回去
--
-- 标记用 chr(5) —— 它不会出现在正常文本里。
b0 AS MATERIALIZED (
  SELECT t FROM p8
),
-- 姓氏表以正则片段内联（由 pgrefuge_en_surname_pattern() 动态生成），
-- 这样 SQL 版与 JS 端「姓必须在 en_surname 表里」的约束完全等价。
-- (?i) 让大小写不敏感 —— JS 端 isEnSurname 用 toLowerCase() 比较，语义一致。
b1 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '(?i)(^|[^A-Za-z])(Mr|Mrs|Ms|Dr|Prof|Sr|Jr)([.]|[[:space:]]+)[[:space:]]*(@@SURNAME@@(-@@SURNAME@@)?)([^A-Za-z]|$)',
    '\1' || chr(2) || '\2. Someone' || chr(2) || '\6', 'g') AS t FROM b0
),
-- ---- b2: 完整称谓 + 姓（Professor Wang / PROFESSOR liu）----
-- 捕获组：1=前边界 2=称谓 3=姓 4=尾字符
b2 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '(?i)(^|[^A-Za-z])(Professor|Advisor|Supervisor|Teacher|Tutor|Mentor|Coordinator|Director|Head|Chair)[[:space:]]+(@@SURNAME@@(-@@SURNAME@@)?)([^A-Za-z]|$)',
    '\1' || chr(2) || '\2 Someone' || chr(2) || '\5', 'g') AS t FROM b1
),
-- ---- b2b: 姓 + 完整称谓（Liu Professor）----
-- 捕获组：1=前边界 2=姓 3=称谓 4=尾字符
b2b AS MATERIALIZED (
  SELECT regexp_replace(t,
    '(?i)(^|[^A-Za-z])(@@SURNAME@@(-@@SURNAME@@)?)[[:space:]]+(Professor|Advisor|Supervisor|Teacher|Tutor|Mentor|Coordinator|Director|Head|Chair)([^A-Za-z]|$)',
    '\1' || chr(2) || 'Someone \4' || chr(2) || '\5', 'g') AS t FROM b2
),
-- ---- b3: 纯姓形态（Liu is my advisor）----
-- 捕获组：1=前边界 2=姓 3=后半句 4=尾字符
b3 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '(?i)(^|[^A-Za-z])(@@SURNAME@@)([[:space:]]+(is|was|are|were)[[:space:]]+(my|our|his|her|their)[[:space:]]+(advisor|supervisor|mentor|tutor|teacher|professor|boss|colleague|friend|roommate|partner))([^A-Za-z]|$)',
    '\1' || chr(2) || 'Someone' || chr(2) || '\3\7', 'g') AS t FROM b2b
),
-- ---- b4: 关系词 + 姓（my advisor Liu）----
-- 捕获组：1=前边界 2=前缀 3=姓 4=尾字符
b4 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '(?i)(^|[^A-Za-z])((my|our|his|her|their)[[:space:]]+(advisor|supervisor|mentor|tutor|teacher|professor|boss|colleague|friend|roommate|partner)[[:space:]]+)(@@SURNAME@@)([^A-Za-z]|$)',
    '\1' || chr(2) || '\2' || chr(2) || 'Someone' || chr(2) || '\6', 'g') AS t FROM b3
),
-- ---- b5: 全名（Ming Liu）----
-- 捕获组：1=前边界 2=名 3=姓 4=后接动词 5=尾字符
b5 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '(?i)(^|[^A-Za-z])([A-Za-z]+)[[:space:]]+(@@SURNAME@@)([[:space:]]+(called|told|asked|said|yelled|scolded|is|was|keeps|always|never|helped|email|contacted|visited|emailed))([^A-Za-z]|$)',
    '\1' || chr(2) || 'Someone Someone' || chr(2) || '\4\6', 'g') AS t FROM b4
),
-- ---- b6: 英文机构名（Tsinghua University）----
-- 捕获组：1=前边界 2=机构名前缀 3=机构词 4=尾字符
b6 AS MATERIALIZED (
  SELECT regexp_replace(t,
    -- 注意：**不能加 (?i)** ——
    --   PG 的 (?i) 会让整个正则大小写不敏感，包括 [A-Z] 这个字符类，
    --   于是 "I am from Tsinghua University" 里的 "am from Tsinghua"
    --   也被当成机构名前缀，整段被吃掉（实测输出 "I ___ University now."）。
    --   所以机构词写成大小写变体，行为与 JS 端一致。
    '(^|[^A-Za-z])([A-Z][a-zA-Z]{1,20}([[:space:]]+[A-Z][a-zA-Z]{1,20}){0,2})[[:space:]]+(University|UNIVERSITY|College|COLLEGE|Institute|INSTITUTE|Laboratory|LABORATORY|Lab|LAB|School|SCHOOL|Academy|ACADEMY|Polytechnic|POLYTECHNIC)([^A-Za-z]|$)',
    '\1' || chr(2) || '___ \4' || chr(2) || '\5', 'g') AS t FROM b5
),
-- ---- 标识符：学号 / 工号 ----
i1 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((学号|工号|学生号|研究生号|学号是|工号是|编号是)[^0-9]{0,4})([0-9]{8,12})',
    '\1' || chr(2) || '某学号' || chr(2), 'g') AS t FROM b6
),
-- ---- 标识符：手机号（含分隔符写法）----
i2 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((手机|电话|手机号|电话号码|联系方式|联系)[^0-9]{0,4})(1[3-9][0-9]([-[:space:]]?[0-9]{4}){2})',
    '\1' || chr(2) || '某号码' || chr(2), 'g') AS t FROM i1
),
-- ---- 标识符：邮箱 ----
i3 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((邮箱|邮件|email|Email|EMAIL|e-mail|E-mail|mail|Mail|MAIL|发到|发给我)[^A-Za-z0-9@]{0,6})([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})',
    '\1' || chr(2) || '某邮箱' || chr(2), 'g') AS t FROM i2
),
-- ---- 标识符：社交账号 ----
i4 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((QQ|qq|Qq|微信|wechat|WeChat|Wechat|微博|weibo|小红书|抖音|钉钉)[^A-Za-z0-9]{0,4})([A-Za-z][A-Za-z0-9_-]{4,19})',
    '\1' || chr(2) || '某账号' || chr(2), 'g') AS t FROM i3
),
-- ---- 标识符：房间号 ----
i5 AS MATERIALIZED (
  SELECT regexp_replace(t,
    '((房间号|房间|办公室号|办公室|工位号|工位|座位号|座位|教室)[^0-9]{0,4})([0-9]{1,4}([-][[:space:]]*[0-9]{1,4})?)',
    '\1' || chr(2) || '某房间' || chr(2), 'g') AS t FROM i4
),
final AS (
  SELECT regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(t, chr(3), '的', 'g'),
          chr(2), '', 'g'),
        chr(1), '', 'g'),
      chr(4), '', 'g'),
    '  ', ' ', 'g') AS content
  FROM i5
),
counts AS (
  SELECT
    (pgrefuge_chr_count(p4.t,2)-pgrefuge_chr_count(p3.t,2))/2 AS school,
    (pgrefuge_chr_count(p5.t,2)-pgrefuge_chr_count(p4.t,2))/2 AS college,
    (pgrefuge_chr_count(p6.t,2)-pgrefuge_chr_count(p5.t,2))/2 AS team,
    (pgrefuge_chr_count(p7.t,2)-pgrefuge_chr_count(p6.t,2))/2 AS person,
    (pgrefuge_chr_count(p8.t,2)-pgrefuge_chr_count(p7.t,2))/2 AS surname,
    (pgrefuge_chr_count(b6.t,2)-pgrefuge_chr_count(p8.t,2))/2 AS person_en,
    (pgrefuge_chr_count(b6.t,2)-pgrefuge_chr_count(b5.t,2))/2 AS org_en
  FROM p3, p4, p5, p6, p7, p8, b1, b2, b2b, b3, b4, b5, b6
)
SELECT json_build_object(
  'content', (SELECT content FROM final),
  'changed', (SELECT content FROM final) <> coalesce(@@TEXT@@, ''),
  'hits', (
    SELECT coalesce(json_agg(json_build_object('kind', kind, 'count', cnt, 'lang', lang)), '[]'::json)
    FROM (
      SELECT 'school' AS kind, school AS cnt, 'cn' AS lang FROM counts
      UNION ALL SELECT 'college', college, 'cn' FROM counts
      UNION ALL SELECT 'team', team, 'cn' FROM counts
      UNION ALL SELECT 'person', person, 'cn' FROM counts
      UNION ALL SELECT 'surname', surname, 'cn' FROM counts
      UNION ALL SELECT 'personEn', person_en, 'en' FROM counts
      UNION ALL SELECT 'orgEn', org_en, 'en' FROM counts
    ) x WHERE cnt > 0
  )
)
$q$, '@@SURNAME@@', v_pat, '@@TEXT@@', quote_literal(v_text));

  EXECUTE v_sql INTO v_res;
  RETURN v_res;
END;
$fn$;
