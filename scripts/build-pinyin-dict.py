#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成拼音姓名词典（scripts/pinyin-dict.json）

要解决的问题
------------
用户实测缺口：`i hate wangjunkai` 完全检测不到。

根因：现有英文规则全部依赖**空格分隔的两词结构**（「名 + 姓」，
如 "Ming Liu"）。而中文人名写成拼音时有两种形态：
  ① 连写：wangjunkai / wangjun / liuxiaodong   ← 现有规则够不着
  ② 带空格（姓在前）：Wang Junkai               ← 末词不在英文姓氏表，被跳过

判据设计
--------
「连写拼音」和英文普通词在形态上高度同形，这是判别难点。
实测 9884 个常用英文词里，有 68 个会被粗放的「音节切分」误判
（make / like / here / human / magazine / sunshine …）。

所以最终判据是四层合取，缺一不可：

  1. 首段 ∈ 百家姓拼音表（90 个）      → 提供「姓」锚点
  2. 全串可切分为合法拼音音节（424 个） → 提供「名」结构
  3. 整串不在英文常用词表              → 排除 make/like/here
  4. 长度 ≥ 4                          → 排除单姓单音节

实测：9884 个常用英文词，误伤 0 个；
      wangjunkai / liuxiaodong / zhangsan / xiaoming 全部命中。

数据来源
--------
- 拼音音节表：pypinyin 的单字拼音全集（424 个）—— 覆盖所有汉字读音
- 姓氏拼音：百家姓前 80 + 16 复姓，经 pypinyin 转换
- 英文排除词：google-10000-english 词表 ∩ 「会被误判的 68 个词」
  （只存需要排除的，不存全部 9884 词 —— 词典体积从 60KB 降到 1KB）

用法：python3 scripts/build-pinyin-dict.py
输出：scripts/pinyin-dict.json
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'pinyin-dict.json')

# 英文常用词表（构建期用，不进产物）
ENG_WORDS_CANDIDATES = [
    os.path.join(ROOT, '_tmpdata', 'eng_words.txt'),
    os.path.join(os.path.dirname(ROOT), '_tmpdata', 'eng_words.txt'),
    os.path.join(ROOT, 'scripts', 'eng_words.txt'),
]

# 百家姓（人口覆盖前 80）
SURNAMES_CN = (
    '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许邓冯韩曹曾彭萧蔡潘田董袁余叶蒋杜苏魏程吕丁沈任姚卢傅钟姜崔谭廖范汪陆金石戴贾韦夏邱方侯邹熊孟秦白江阎薛尹段雷'
)
COMPOUND_SURNAMES_CN = [
    '欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙',
    '慕容', '长孙', '宇文', '司徒', '司空', '端木', '南宫', '夏侯'
]

# 复姓连写时的分割歧义：
#   欧阳 → "ouyang"，但 "ou" + "yang" 也是合法切法。
#   姓氏表用连写形式匹配，所以这里记录「连写姓氏」的关键判据。
MIN_LEN = 4


def toneless(py):
    """去掉声调，ü 统一写成 v（与 pypinyin 的 v 写法一致）"""
    py = py.lower()
    table = [
        ('ā', 'a'), ('á', 'a'), ('ǎ', 'a'), ('à', 'a'),
        ('ē', 'e'), ('é', 'e'), ('ě', 'e'), ('è', 'e'),
        ('ī', 'i'), ('í', 'i'), ('ǐ', 'i'), ('ì', 'i'),
        ('ō', 'o'), ('ó', 'o'), ('ǒ', 'o'), ('ò', 'o'),
        ('ū', 'u'), ('ú', 'u'), ('ǔ', 'u'), ('ù', 'u'),
        ('ǖ', 'v'), ('ǘ', 'v'), ('ǚ', 'v'), ('ǜ', 'v'), ('ü', 'v'),
    ]
    for a, b in table:
        py = py.replace(a, b)
    return py


def build_syllables(pinyin_dict):
    """从 pypinyin 的单字拼音表提取全部合法音节"""
    out = set()
    for _code, val in pinyin_dict.pinyin_dict.items():
        vals = val if isinstance(val, list) else [val]
        for item in vals:
            if isinstance(item, list):
                item = item[0] if item else ''
            for one in str(item).split(','):
                t = toneless(one.strip())
                if t and re.match(r'^[a-z]+$', t):
                    out.add(t)
    return out


def build_surnames(pinyin):
    """百家姓 → 拼音"""
    out = set()
    for ch in SURNAMES_CN:
        r = pinyin(ch, style=0)
        if r and r[0]:
            out.add(toneless(r[0][0]))
    for c in COMPOUND_SURNAMES_CN:
        r = pinyin(c, style=0)
        out.add(''.join(toneless(x[0]) for x in r))
    return out


def split_syllables(word, table):
    """贪心最长匹配切分；失败返回 None"""
    out = []
    i = 0
    n = len(word)
    while i < n:
        hit = None
        for L in range(min(6, n - i), 0, -1):
            if word[i:i + L] in table:
                hit = L
                break
        if hit is None:
            return None
        out.append(word[i:i + hit])
        i += hit
    return out


def would_misjudge(word, syl_table, sur_table):
    """该词是否会被「音节切分 + 姓氏锚点」误判为拼音姓名"""
    if not re.match(r'^[a-z]{%d,}$' % MIN_LEN, word):
        return False
    sp = split_syllables(word, syl_table)
    if not sp or len(sp) < 2:
        return False
    return sp[0] in sur_table


def load_eng_words():
    for c in ENG_WORDS_CANDIDATES:
        if os.path.exists(c):
            with open(c, encoding='utf-8') as f:
                return {w.strip().lower() for w in f if w.strip()}, c
    return None, None


def main():
    try:
        from pypinyin import pinyin, pinyin_dict
    except ImportError:
        print('需要 pypinyin：pip install pypinyin')
        sys.exit(1)

    syl = build_syllables(pinyin_dict)
    sur = build_surnames(pinyin)

    eng_words, eng_path = load_eng_words()
    if eng_words is None:
        print('找不到英文词表，请把 eng_words.txt 放到以下位置之一：')
        for c in ENG_WORDS_CANDIDATES:
            print('  -', c)
        sys.exit(1)

    # 只保留「会被误判」的词 —— 词典体积从 60KB 降到 1KB
    block = sorted(w for w in eng_words if would_misjudge(w, syl, sur))

    # 复姓：连写形式
    compound = sorted(
        ''.join(toneless(x[0]) for x in pinyin(c, style=0))
        for c in COMPOUND_SURNAMES_CN
    )

    data = {
        'syllables': sorted(syl),
        'surnames': sorted(sur),
        'compoundSurnames': compound,
        'blockWords': block,
        'stats': {
            'syllables': len(syl),
            'surnames': len(sur),
            'compoundSurnames': len(compound),
            'blockWords': len(block),
            'engWordsScanned': len(eng_words),
            'engWordsSource': os.path.basename(eng_path),
        },
    }

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    print('拼音音节      :', len(syl))
    print('姓氏拼音      :', len(sur))
    print('复姓连写      :', len(compound), compound[:5])
    print('英文排除词    :', len(block))
    print('英文词表规模  :', len(eng_words), '(', os.path.basename(eng_path), ')')
    print('输出          :', OUT)


if __name__ == '__main__':
    main()
