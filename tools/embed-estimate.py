#!/usr/bin/env python3
"""Estimate how much of the NAS conversation archive is worth embedding, and how big the vectors would be.

Read-only: opens knowledge.sqlite with mode=ro and only SELECTs. Run on the NAS (the script can come over stdin):

    ssh nas '/volume2/docker/ame-embed/miniforge3/envs/ame-embed/bin/python - \
        --db /volume2/docker/ame-remote/remote/server/data/knowledge.sqlite \
        --key /volume2/docker/ame-remote/secrets/embed-remote3090.key' < tools/embed-estimate.py > estimate.json

What counts as "worth embedding" (the plan in docs/embedding-plan.md):
  - Claude Code: the user's own prompts (string content or text blocks; not tool results, not isMeta, not
    command/hook output that starts with '<'; <system-reminder> blocks stripped) and the assistant's text blocks
    (not thinking, not tool_use).
  - Codex: event_msg user_message / agent_message (what the user typed and what the agent said, without the
    injected AGENTS.md / environment context that response_item user messages carry).
  - Everything else (tool calls, tool output, thinking) is counted for comparison only.
  - agy / kiro / opencode are not parsed here (about 7 % of the archive bytes); the plan scales them by bytes.
Chunks: a message of up to CHUNK characters is one chunk; longer ones are cut every CHUNK characters.
Tokens per character is measured by sending a sample to the embedding service (its usage.prompt_tokens).
"""
import argparse, collections, json, math, random, re, sqlite3, sys, time, urllib.request

CHUNK = 600
MIN_CHARS = 8
REMINDER = re.compile(r'<system-reminder>.*?</system-reminder>', re.S)


def clean_user(text):
    text = REMINDER.sub('', text).strip()
    return '' if text.startswith('<') else text


def claude_texts(line):
    """yield (role, text, day) for one Claude Code transcript line; role 'tool' for tool output (counted only)"""
    try:
        r = json.loads(line)
    except Exception:
        return
    if not isinstance(r, dict) or r.get('isMeta'):
        return
    day = (r.get('timestamp') or '')[:10]
    msg = r.get('message') or {}
    content = msg.get('content')
    if r.get('type') == 'user':
        if isinstance(content, str):
            t = clean_user(content)
            if t:
                yield 'user', t, day
        elif isinstance(content, list):
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'text':
                    t = clean_user(b.get('text') or '')
                    if t:
                        yield 'user', t, day
                elif b.get('type') == 'tool_result':
                    c = b.get('content')
                    n = len(c) if isinstance(c, str) else sum(len(x.get('text') or '') for x in c or [] if isinstance(x, dict))
                    yield 'tool', str(n), day
    elif r.get('type') == 'assistant' and isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'text' and (b.get('text') or '').strip():
                yield 'assistant', b['text'].strip(), day


def codex_texts(line):
    try:
        r = json.loads(line)
    except Exception:
        return
    if not isinstance(r, dict):
        return
    day = (r.get('timestamp') or '')[:10]
    p = r.get('payload') or {}
    if r.get('type') == 'event_msg':
        if p.get('type') == 'user_message' and (p.get('message') or '').strip():
            yield 'user', p['message'].strip(), day
        elif p.get('type') == 'agent_message' and (p.get('message') or '').strip():
            yield 'assistant', p['message'].strip(), day
    elif r.get('type') == 'response_item' and p.get('type') == 'function_call_output':
        yield 'tool', str(len(str(p.get('output') or ''))), day


def chunks_of(n):
    return max(1, math.ceil(n / CHUNK))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--key', help='embedding service key file; measures tokens per character on a sample')
    ap.add_argument('--url', default='http://192.168.114.3:8090')
    a = ap.parse_args()
    db = sqlite3.connect(f'file:{a.db}?mode=ro', uri=True)
    t0 = time.time()

    totals = collections.defaultdict(lambda: collections.Counter())   # (provider, scope, role) -> counters
    daily = collections.defaultdict(collections.Counter)               # day -> chars of embeddable text
    lengths = []                                                        # embeddable message lengths
    sample = []
    raw = collections.Counter()
    sources = db.execute("select machine,key,generation,provider,parent,size from sources "
                         "where kind='native' and provider in ('claude','codex')").fetchall()
    for machine, key, gen, provider, parent, size in sources:
        scope = 'subagent' if parent else 'main'
        raw[(provider, scope)] += size or 0
        data = b''.join(r[0] for r in db.execute(
            'select data from chunks where machine=? and key=? and generation=? order by start', (machine, key, gen)))
        parse = claude_texts if provider == 'claude' else codex_texts
        for line in data.decode('utf-8', 'replace').splitlines():
            for role, text, day in parse(line):
                c = totals[(provider, scope, role)]
                if role == 'tool':
                    c['messages'] += 1
                    c['chars'] += int(text)
                    continue
                if len(text) < MIN_CHARS:
                    continue
                c['messages'] += 1
                c['chars'] += len(text)
                c['chunks'] += chunks_of(len(text))
                daily[day][f'{provider}:{scope}'] += len(text)
                lengths.append(len(text))
                if random.random() < 0.004 and len(sample) < 400:
                    sample.append(text[:CHUNK])

    out = {'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'chunk_chars': CHUNK, 'scan_seconds': round(time.time() - t0, 1),
           'raw_bytes': {f'{p}:{s}': v for (p, s), v in raw.items()},
           'totals': {f'{p}:{s}:{r}': dict(c) for (p, s, r), c in sorted(totals.items())},
           'daily_chars': {d: dict(c) for d, c in sorted(daily.items()) if d},
           'message_length_quantiles': {}}
    if lengths:
        lengths.sort()
        q = lambda f: lengths[min(len(lengths) - 1, int(f * len(lengths)))]
        out['message_length_quantiles'] = {'p50': q(.5), 'p90': q(.9), 'p99': q(.99), 'max': lengths[-1],
                                           'count': len(lengths)}
    if a.key and sample:
        key = open(a.key).read().strip()
        tok = chars = 0
        for i in range(0, len(sample), 16):
            batch = sample[i:i + 16]
            req = urllib.request.Request(a.url + '/v1/embeddings', data=json.dumps({'input': batch}).encode(),
                                         headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
            with urllib.request.urlopen(req, timeout=120) as r:
                tok += json.loads(r.read())['usage']['prompt_tokens']
            chars += sum(len(s) for s in batch)
        out['tokens_per_char'] = round(tok / chars, 4)
        out['token_sample'] = {'texts': len(sample), 'chars': chars, 'tokens': tok}
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
