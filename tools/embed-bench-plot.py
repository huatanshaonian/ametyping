"""Draw docs/img/embed-bench.png from a JSON written by embed-bench.py.

    python tools/embed-bench-plot.py docs/data/embed-bench-20261123.json docs/img/embed-bench.png
"""
import json, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding='utf-8'))
rows = d['load']
labels = [f"批 {r['batch']}\n并发 {r['workers']}" for r in rows]
tps = [r['tokens_per_s'] for r in rows]
p50 = [r['request_p50_s'] * 1000 for r in rows]

fig, (a1, a2, a3) = plt.subplots(1, 3, figsize=(13, 3.9), gridspec_kw={'width_ratios': [1.3, 1.3, 1]})

a1.bar(labels, tps, color='#4d23cf')
for i, v in enumerate(tps):
    a1.text(i, v + 60, f'{v:.0f}', ha='center', fontsize=9)
a1.set_title('吞吐（token/s）：批大小和并发基本不影响')
a1.set_ylim(0, max(tps) * 1.18)
a1.tick_params(axis='x', labelsize=8)

a2.bar(labels, p50, color='#c4a9f8')
for i, v in enumerate(p50):
    a2.text(i, v * 1.15, f'{v:.0f}', ha='center', fontsize=9)
a2.set_yscale('log')
a2.set_title('单次请求耗时 p50（ms，对数轴）')
a2.set_ylim(10, max(p50) * 4)
a2.tick_params(axis='x', labelsize=8)

exp, got, cut = d['card_expected'], d['card_full'], d['card_1024']
pairs = ['问1-文1', '问1-文2', '问2-文1', '问2-文2']
flat = lambda m: [m[0][0], m[0][1], m[1][0], m[1][1]]
x = range(4)
w = 0.27
a3.bar([i - w for i in x], flat(exp), w, label='模型卡期望', color='#888888')
a3.bar(list(x), flat(got), w, label='本服务 2560 维', color='#4d23cf')
a3.bar([i + w for i in x], flat(cut), w, label='截到 1024 维', color='#90c8f4')
a3.set_xticks(list(x))
a3.set_xticklabels(pairs, fontsize=8)
a3.set_title(f"正确性：最大偏差 {d['card_max_abs_err']}")
a3.legend(fontsize=8)

fig.suptitle(f"remote3090 (RTX 3080) · Qwen3-Embedding-4B Q8_0 · 从 NAS 调用 · 单条查询 p50 {d['query_latency_ms']['p50']} ms · {d['at']}",
             fontsize=10)
fig.tight_layout()
fig.savefig(out, dpi=130)
print('saved', out)
