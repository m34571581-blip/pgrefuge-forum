#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 JS 端的姓名词典同步到 PostgreSQL 服务端。

为什么需要：
  JS 端（forum / 小程序 / 浏览器）用的是 scripts/name-dict.json，
  服务端 SQL 用的是 name_char / en_surname / cn_surname 等表。
  两份词典如果各自维护，一定会漂移 —— 表现就是
  「小程序预览说脱敏了、服务端入库没脱敏」。

  所以词典**只有一份真源**（name-dict.json），由这个脚本导入服务端。

用法：
  python3 scripts/sync-server-dict.py --sql-out server-dict.sql
  然后把 server-dict.sql 的内容提交给服务端执行。

  （直接连数据库需要连接串；本项目用的是云开发 MCP，
    所以这里生成 SQL 文本，交给 MCP 执行。）
"""
import argparse
import io
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DICT_FILE = os.path.join(HERE, 'name-dict.json')


def load_dict():
    with io.open(DICT_FILE, encoding='utf-8') as f:
        return json.load(f)


def quote_list(values):
    """把字符串数组转成 SQL VALUES 列表"""
    out = []
    for v in values:
        escaped = v.replace("'", "''")
        out.append("('%s')" % escaped)
    return ',\n  '.join(out)


def build_sql(d):
    """
    生成服务端 SQL。

    两部分：
      1. 词典表的 INSERT（名字用字、中文姓、复姓、排除词）
      2. **完整的 desensitize_detail 函数定义**

    为什么第 2 部分也要生成：
      服务端的脱敏函数与 JS 端是**两份实现**，必须由同一个来源产出，
      否则会漂移（表现：预览显示已脱敏、实际入库带着真名）。

      英文姓氏表不用内联进正则 —— PG 的 regexp_replace 要求正则是
      编译期常量，动态拼接会静默失效；函数用 plpgsql + EXECUTE 解决，
      姓氏表仍然存在表里，改词典只需 UPDATE。
    """
    parts = []
    parts.append('-- 自动生成，请勿手改')
    parts.append('-- 源文件: scripts/name-dict.json')
    parts.append('-- 生成器: scripts/sync-server-dict.py')
    parts.append('')
    parts.append('BEGIN;')
    parts.append('')

    # 名字用字
    parts.append('DELETE FROM public.name_char;')
    parts.append('INSERT INTO public.name_char (ch) VALUES')
    parts.append('  ' + quote_list(d['nameChars']) + ';')
    parts.append('')

    # 英文姓氏（从 JS 引擎的 EN_SURNAMES 提取，服务端版本同步维护在 name-dict.json）
    en = d.get('enSurnames', [])
    if en:
        parts.append('DELETE FROM public.en_surname;')
        parts.append('INSERT INTO public.en_surname (s) VALUES')
        parts.append('  ' + quote_list(en) + ';')
        parts.append('')

    # 中文姓氏
    parts.append('DELETE FROM public.cn_surname;')
    parts.append('INSERT INTO public.cn_surname (s) VALUES')
    parts.append('  ' + quote_list(d['surnames']) + ';')
    parts.append('')

    # 复姓
    parts.append('DELETE FROM public.cn_compound_surname;')
    parts.append('INSERT INTO public.cn_compound_surname (s) VALUES')
    parts.append('  ' + quote_list(d['compoundSurnames']) + ';')
    parts.append('')

    # 排除词
    if d.get('blockBigrams'):
        parts.append('DELETE FROM public.name_block_bigram;')
        parts.append('INSERT INTO public.name_block_bigram (s) VALUES')
        parts.append('  ' + quote_list(d['blockBigrams']) + ';')
        parts.append('')

    # ---- 函数定义 ----
    #
    # 注意：英文姓氏表**不需要**内联进正则。
    #   PG 的 regexp_replace 要求正则是编译期常量，动态拼接会静默失效；
    #   所以函数改成 plpgsql + EXECUTE —— 运行时把姓氏表拼进 SQL 文本再执行。
    #   这样姓氏表仍然是**表**，改词典只需 UPDATE，不用重新部署函数。
    #
    # server-schema.sql 里用的是 format() 的位置参数 %1$s，
    # 由函数运行时传入 v_pat（姓氏表的正则片段）。
    with io.open(os.path.join(HERE, 'server-schema.sql'), encoding='utf-8') as f:
        schema = f.read()
    parts.append(schema)
    parts.append('')

    parts.append('COMMIT;')
    parts.append('')
    return '\n'.join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sql-out', help='输出 SQL 文件路径')
    args = ap.parse_args()

    d = load_dict()
    sql = build_sql(d)

    if args.sql_out:
        with io.open(args.sql_out, 'w', encoding='utf-8', newline='\n') as f:
            f.write(sql)
        print('[ok] 词典 SQL 已生成: %s (%d 字符)' % (args.sql_out, len(sql)))
    else:
        print(sql)

    print('[i] 名字用字 %d | 英文姓 %d | 中文姓 %d | 复姓 %d | 排除词 %d' % (
        len(d['nameChars']),
        len(d.get('enSurnames', [])),
        len(d['surnames']),
        len(d['compoundSurnames']),
        len(d.get('blockBigrams', []))
    ))


if __name__ == '__main__':
    main()
