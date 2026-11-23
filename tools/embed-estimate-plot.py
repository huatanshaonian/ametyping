"""Draw docs/img/embed-estimate.png from the two estimate JSONs.

    python tools/embed-estimate-plot.py docs/data/embed-estimate-20261123.json docs/data/embed-sources-20261123.json docs/img/embed-estimate.png
"""
import datetime, json, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

est = json.load(open(sys.argv[1], encoding='utf-8'))
src = json.load(open(sys.argv[2], encoding='utf-8'))
out = sys.argv[3]
fig, (a1, a2, a3) = plt.subplots(1, 3, figsize=(15, 4.4), gridspec_kw={'width_ratios': [1.1, 1.6, 1.2]})

# 1. Claude + Codex: raw bytes vs what is worth embedding
raw = sum(est['raw_bytes'].values())
tot = est['totals']
tool = sum(v['chars'] for k, v in tot.items() if k.endswith(':tool'))
user = sum(v['chars'] for k, v in tot.items() if k.endswith(':user'))
asst = sum(v['chars'] for k, v in tot.items() if k.endswith(':assistant'))
labels = ['原始存档\n(字节)', '工具输出\n(字)', '助手回复\n(字)', '用户提问\n(字)']
vals = [raw, tool, asst, user]
a1.bar(labels, vals, color=['#888888', '#c4a9f8', '#4d23cf', '#90c8f4'])
a1.set_yscale('log')
for i, v in enumerate(vals):
    a1.text(i, v * 1.25, f'{v / 1e6:.1f}M', ha='center', fontsize=9)
a1.set_ylim(1e5, raw * 6)
a1.set_title('Claude + Codex：真正要 embed 的只占 0.2%')
a1.tick_params(axis='x', labelsize=8)

# 2. embeddable characters per day (record timestamps)
days = sorted(d for d in est['daily_chars'] if d >= '2026-09-01')
xs = [datetime.date.fromisoformat(d) for d in days]
ys = [sum(est['daily_chars'][d].values()) / 1000 for d in days]
a2.bar(xs, ys, width=0.9, color='#4d23cf')
a2.set_title('每天新增的可 embed 文字（千字，Claude + Codex）')
a2.set_ylabel('千字')
tpc = src['service']['tokens_per_char_sample']
sec = max(ys) * 1000 * tpc / src['service']['tokens_per_s']
a2.text(0.02, 0.92, f'最多的一天 {max(ys):.0f} 千字，约 {sec:.0f} 秒 GPU', transform=a2.transAxes, fontsize=9)
for lab in a2.get_xticklabels():
    lab.set_rotation(30)
    lab.set_ha('right')

# 3. candidate sources, characters
lines = src['search_db_lines']['by_role']
lit = src['literature']
cands = [
    ('对话 提问+回复', lines['user']['chars'] + lines['assistant']['chars']),
    ('目录摘要', src['knowledge_other']['research_directory_summaries']['chars']),
    ('文献摘要', lit['abstract_chars']),
    ('日报', src['search_db_docs']['report']['chars']),
    ('邮件', src['search_db_docs']['mail']['chars']),
    ('记忆条目', src['knowledge_other']['memory']['chars']),
    ('文献全文(估)', 549 * 50000),
]
cands.sort(key=lambda x: x[1])
a3.barh([c[0] for c in cands], [c[1] / 1e6 for c in cands],
        color=['#ffb36b' if '估' in c[0] else '#4d23cf' for c in cands])
for i, (_, v) in enumerate(cands):
    a3.text(v / 1e6 + 0.2, i, f'{v / 1e6:.2f}M', va='center', fontsize=8)
a3.set_title('候选来源的文字量（百万字；橙色是估算）')
a3.set_xlim(0, max(c[1] for c in cands) / 1e6 * 1.25)

fig.suptitle('NAS 存档的 embed 估算 · 2026-11-23 只读统计 · 数据：docs/data/embed-*-20261123.json', fontsize=10)
fig.tight_layout()
fig.savefig(out, dpi=125)
print('saved', out)
