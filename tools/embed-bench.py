#!/usr/bin/env python3
"""Check and measure the embedding service on remote3090 (llama-server, Qwen3-Embedding-4B Q8_0).

Standard library only (the NAS has Python 3.8 without numpy). Run it on the NAS, the real caller:

    /volume2/docker/ame-embed/miniforge3/envs/ame-embed/bin/python embed-bench.py   (python3 works too) --url http://192.168.114.3:8090 \
        --key-file /volume2/docker/ame-remote/secrets/embed-remote3090.key \
        --corpus /volume2/docker/ame-remote/docs --out /volume2/docker/ame-embed/embed-bench.json

What it does, in order:
  1. auth: a request without the key must be refused (401)
  2. correctness: the four example texts from the Qwen3-Embedding-4B model card must give the card's
     similarity matrix [[0.7534, 0.1147], [0.0320, 0.6258]] (full 2560 dims), and roughly the same after
     cutting the vectors to 1024 dims (Matryoshka)
  3. latency of one short query, repeated
  4. throughput: markdown files cut into ~500-character chunks, sent at several batch sizes and concurrencies
Everything measured is written to --out as JSON.
"""
import argparse, glob, json, math, os, statistics, threading, time, urllib.error, urllib.request

TASK = 'Given a web search query, retrieve relevant passages that answer the query'
QUERIES = ['What is the capital of China?', 'Explain gravity']
DOCS = ['The capital of China is Beijing.',
        'Gravity is a force that attracts two bodies towards each other. It gives weight to physical objects '
        'and is responsible for the movement of planets around the sun.']
EXPECTED = [[0.7534, 0.1147], [0.0320, 0.6258]]


def query_text(q, task=TASK):
    return f'Instruct: {task}\nQuery:{q}'


def post(url, key, inputs, timeout=300):
    body = json.dumps({'input': inputs, 'model': 'qwen3-embedding-4b'}).encode()
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    req = urllib.request.Request(url + '/v1/embeddings', data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    vecs = [x['embedding'] for x in sorted(d['data'], key=lambda x: x['index'])]
    return vecs, d.get('usage', {}).get('prompt_tokens', 0)


def norm(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def cos(a, b):
    return sum(x * y for x, y in zip(norm(a), norm(b)))


def chunks_from(folder, size=500, limit=512):
    out = []
    for f in sorted(glob.glob(os.path.join(folder, '**', '*.md'), recursive=True)):
        text = open(f, encoding='utf-8', errors='ignore').read()
        for i in range(0, len(text), size):
            piece = text[i:i + size].strip()
            if len(piece) > 50:
                out.append(piece)
    while out and len(out) < limit:      # a small corpus is repeated to reach the sample size
        out += out[:limit - len(out)]
    return out[:limit]


def run_load(url, key, chunks, batch, workers):
    batches = [chunks[i:i + batch] for i in range(0, len(chunks), batch)]
    lock, tokens, lat = threading.Lock(), [0], []
    it = iter(batches)

    def work():
        while True:
            with lock:
                b = next(it, None)
            if b is None:
                return
            t0 = time.perf_counter()
            _, n = post(url, key, b)
            dt = time.perf_counter() - t0
            with lock:
                tokens[0] += n
                lat.append(dt)

    t0 = time.perf_counter()
    ts = [threading.Thread(target=work) for _ in range(workers)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    wall = time.perf_counter() - t0
    return {'batch': batch, 'workers': workers, 'chunks': len(chunks), 'seconds': round(wall, 3),
            'chunks_per_s': round(len(chunks) / wall, 2), 'tokens': tokens[0],
            'tokens_per_s': round(tokens[0] / wall, 1),
            'request_p50_s': round(statistics.median(lat), 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://192.168.114.3:8090')
    ap.add_argument('--key-file', required=True)
    ap.add_argument('--corpus', required=True, help='folder of .md files used as test text')
    ap.add_argument('--out', default='embed-bench.json')
    a = ap.parse_args()
    key = open(a.key_file).read().strip()
    res = {'url': a.url, 'at': time.strftime('%Y-%m-%dT%H:%M:%S')}

    # 1. auth
    try:
        post(a.url, '', ['x'], timeout=20)
        res['auth_without_key'] = 'ACCEPTED (bad)'
    except urllib.error.HTTPError as e:
        res['auth_without_key'] = e.code

    # 2. correctness against the model card
    vecs, _ = post(a.url, key, [query_text(q) for q in QUERIES] + DOCS)
    res['dims'] = len(vecs[0])
    full = [[round(cos(vecs[i], vecs[2 + j]), 4) for j in range(2)] for i in range(2)]
    cut = [[round(cos(vecs[i][:1024], vecs[2 + j][:1024]), 4) for j in range(2)] for i in range(2)]
    res['card_expected'] = EXPECTED
    res['card_full'] = full
    res['card_1024'] = cut
    res['card_max_abs_err'] = round(max(abs(full[i][j] - EXPECTED[i][j]) for i in range(2) for j in range(2)), 4)
    noinst, _ = post(a.url, key, QUERIES)
    res['card_without_instruction'] = [[round(cos(noinst[i], vecs[2 + j]), 4) for j in range(2)] for i in range(2)]

    # 3. latency of one short query
    lat = []
    for _ in range(20):
        t0 = time.perf_counter()
        post(a.url, key, [query_text('那次网格加密的收敛性测试结果在哪')])
        lat.append(time.perf_counter() - t0)
    lat.sort()
    res['query_latency_ms'] = {'p50': round(lat[10] * 1000, 1), 'p95': round(lat[18] * 1000, 1),
                               'min': round(lat[0] * 1000, 1)}

    # 4. throughput
    chunks = chunks_from(a.corpus)
    res['corpus_chunks'] = len(chunks)
    res['load'] = []
    for batch, workers in [(1, 1), (8, 1), (32, 1), (8, 4), (32, 4)]:
        r = run_load(a.url, key, chunks, batch, workers)
        res['load'].append(r)
        print(r, flush=True)

    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in res.items() if k != 'load'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
