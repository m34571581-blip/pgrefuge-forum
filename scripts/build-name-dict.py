#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从真实语料反推「姓+字」后缀的用字分布，生成两个词典：

  NAME_CHARS  —— 偏向人名的用字（低地理/低行政/低功能词特征）
  PLACE_CHARS —— 偏向行政地名/朝代/度量衡的用字（高特征字）

思路（数据驱动，不靠手写）：
  语料里「姓 + 单字」有两类：
    人名   刘翔 / 姚明 / 吴璇
    普通词 唐朝 / 任务 / 河南 / 夏季
  两类在「后接字的语义类别」上有系统性差异。
  通过统计每个字在「姓+字」中的出现频次与它在全语料中的背景频次，
  找出那些**只在姓后大量出现**的字 → 名字用字；
  找出那些**在全语料里也高频**的字 → 行政/地理/功能字（需排除）。

用法：python3 scripts/build-name-dict.py
输出：scripts/name-dict.json
"""
import json
import re
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# 语料文件放在工作区根目录（抓取脚本产出），也可放在项目根
CORPUS_CANDIDATES = [
    os.path.join(ROOT, '_corpus_fragments.json'),
    os.path.join(os.path.dirname(ROOT), '_corpus_fragments.json'),
]
OUT = os.path.join(HERE, 'name-dict.json')

# 百家姓（人口覆盖前 100，含复姓）
SURNAMES = set(
    '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许邓冯韩曹曾彭萧蔡潘田董袁余叶蒋杜苏魏程吕丁沈任姚卢傅钟姜崔谭廖范汪陆金石戴贾韦夏邱方侯邹熊孟秦白江阎薛尹段雷'
)
COMPOUND = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙',
            '慕容', '长孙', '宇文', '司徒', '司空', '端木', '南宫', '夏侯']

# 功能词（虚词）—— 姓氏后接这些字几乎必然是普通词
FUNCTION_CHARS = set(
    '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'
    '着过来去给让把被叫让请帮替给或及于至到对朝据按由使即则却比所只将已未亦皆咸弗勿毋'
)

# 明显不是人名的组合（人工补充少量高频歧义词）
BLOCK_BIGRAMS = set(
    ('方面 方向 方案 方法 方程 程度 工程 成功 成果 白天 明白 明天 昨天 今日 去年 今年 每月 每天 '
     '马路 马上 马桶 马车 马力 云龙 云飞 毛巾 毛病 老虎 兔子 猴子 狮子 车子 桌子 房子 叶子 花生 '
     '水果 米饭 面粉 战争 战士 武力 日记 日期 时候 时间 钟表 钟声 唐山 武汉 成都 南京 北京 上海 '
     '广州 长江 黄河 白色 百事 百姓 百分 百年 千万 万一 问题 风机 闪电 雷鸣 雷达 雪山 雷区 范围 '
     '章程 于是 何况 何时 姓王 余下 段落 台阶 任务 任命 任何 主任 何塞 何礼 余部 余座 夏代 夏季 '
     '宋代 唐初 唐朝 明朝 元朝 汉朝 民国 唐代 古代 现代 当代 近代 上代 下代 千代 万代 迭代 '
     '存款 存量 定向 定期 定点 定位 定时 定量 定性 定律 定额 定价 定制 定义 定理').split()
)


def main():
    corpus = None
    for c in CORPUS_CANDIDATES:
        if os.path.exists(c):
            corpus = c
            break
    if not corpus:
        print('找不到语料文件，请先运行抓取脚本。已查找：')
        for c in CORPUS_CANDIDATES:
            print('  -', c)
        sys.exit(1)

    frags = json.load(open(corpus, encoding='utf-8'))

    # ---- 背景频次：全语料里每个字作为「双字词第二字」出现的次数 ----
    bg = {}
    for w in frags:
        if len(w) == 2:
            bg[w[1]] = bg.get(w[1], 0) + 1

    # ---- 候选：姓 + 1 字，且后字不是功能词 ----
    cand = []
    for w in frags:
        if len(w) != 2:
            continue
        if w[0] not in SURNAMES:
            continue
        if w[1] in FUNCTION_CHARS:
            continue
        if w in BLOCK_BIGRAMS:
            continue
        cand.append(w)

    # ---- 姓后频次 ----
    sf = {}
    for w in cand:
        sf[w[1]] = sf.get(w[1], 0) + 1

    # ---- 判别：姓后频次 / 全语料背景频次 ----
    # 高比值 = 几乎只在姓后出现 → 人名用字
    # 低比值 = 全语料里也高频 → 行政/地理/通用字 → 排除
    score = {}
    for ch, n in sf.items():
        b = bg.get(ch, 0)
        ratio = n / (b + 1)     # 加 1 平滑
        score[ch] = (n, b, ratio)

    # 阈值：至少在姓后出现 2 次，且比值 >= 1.0（不低于背景）
    name_chars = sorted(
        ch for ch, (n, b, r) in score.items()
        if n >= 2 and r >= 1.0
    )
    # 高频功能/地理字：全语料背景频次 >= 8 → 排除
    place_chars = sorted(ch for ch, b in bg.items() if b >= 8)

    # 复姓
    compound_hits = sorted({
        w for w in frags
        if len(w) in (3, 4) and any(w.startswith(c) for c in COMPOUND)
    })

    data = {
        'nameChars': name_chars,
        'placeChars': place_chars,
        'compoundSurnames': COMPOUND,
        'blockBigrams': sorted(BLOCK_BIGRAMS),
        'stats': {
            'corpusFragments': len(frags),
            'candidates': len(cand),
            'nameChars': len(name_chars),
            'placeChars': len(place_chars),
        },
    }

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    print('语料片段      :', len(frags))
    print('姓+字候选     :', len(cand))
    print('名字用字       :', len(name_chars))
    print('  →', ''.join(name_chars))
    print('排除用字       :', len(place_chars))
    print('复姓命中       :', len(compound_hits))
    print('输出           :', OUT)


if __name__ == '__main__':
    main()
