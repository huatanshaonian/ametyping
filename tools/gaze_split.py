# Split the 8 painted gaze patches into three layers -- the eye white, one complete iris disc, and the lid lines
# that sit on top -- and measure how far the iris is from the neutral position in each painted direction.
import json, os, sys
import numpy as np
from PIL import Image

#
#   python tools/gaze_split.py [check_dir]
# writes gaze_white.png / gaze_iris.png / gaze_lid.png into app/assets/rig and prints the numbers for gaze_smooth.js;
# with check_dir it also saves a sheet there comparing every painted patch with the eye rebuilt from the layers.
# Needs numpy + Pillow.
RIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'assets', 'rig')
OUT = RIG
CHECK = sys.argv[1] if len(sys.argv) > 1 else None
X, Y, W, H = 394, 552, 116, 71
DIRS = ['r', 'dr', 'd', 'dl', 'l', 'ul', 'u', 'ur']
center = np.asarray(Image.open(os.path.join(RIG, 'head.png')).convert('RGBA').crop((X, Y, X + W, Y + H))).astype(float)
P = {d: np.asarray(Image.open(os.path.join(RIG, f'gaze_{d}.png')).convert('RGBA')).astype(float) for d in DIRS}
N = len(DIRS)

def erode(m, n=1):
    for _ in range(n):
        p = np.pad(m, 1); m = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return m
def dilate(m, n=1):
    for _ in range(n):
        p = np.pad(m, 1); m = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return m
lum = lambda img: img[..., :3] @ np.array([0.299, 0.587, 0.114])
sat = lambda img: img[..., :3].max(-1) - img[..., :3].min(-1)

# --- 1. where is the iris in each patch? match the pupil (never under a lid) between images
def locate(img, tpl, tx0, ty0, rx=44, ry=24):
    th, tw = tpl.shape[:2]; best = None
    for dy in range(-ry, ry + 1):
        for dx in range(-rx, rx + 1):
            x, y = tx0 + dx, ty0 + dy
            if x < 0 or y < 0 or x + tw > W or y + th > H: continue
            win = img[y:y + th, x:x + tw]
            if win[..., 3].min() < 250: continue
            e = ((win[..., :3] - tpl) ** 2).mean()
            if best is None or e < best[0]: best = (e, dx, dy)
    return best
TX0, TY0, TW, TH = 44, 14, 26, 32            # pupil box in the neutral (head.png) eye
_, lx, ly = locate(P['l'], center[TY0:TY0 + TH, TX0:TX0 + TW, :3], TX0, TY0)
ref = P['l'][TY0 + ly:TY0 + ly + TH, TX0 + lx:TX0 + lx + TW, :3]      # the same pupil, as painted in the patches
off = {}
for d in DIRS:
    e, dx, dy = locate(P[d], ref, TX0 + lx, TY0 + ly, 60, 30)
    off[d] = (lx + dx, ly + dy)
    print(f'{d:>2}: offset {off[d][0]:+3d},{off[d][1]:+3d}  match error {e:7.1f}')

# --- 2. the lid lines: dark in nearly every patch at the same spot, close to the edge of the opening
opening = np.mean([P[d][..., 3] for d in DIRS], axis=0)
solid = np.min([P[d][..., 3] for d in DIRS], axis=0) >= 250
depth = np.zeros((H, W), int); m = solid.copy()
while m.any(): depth += m; m = erode(m)
dark_votes = np.sum([(lum(P[d]) < 105) & solid for d in DIRS], axis=0)
lid = (dark_votes >= N - 1) & (depth <= 9)
lid = dilate(lid, 1) & (np.sum([(lum(P[d]) < 150) & solid for d in DIRS], axis=0) >= N - 1) & (depth <= 10)   # + soft edge
print('lid-line pixels:', int(lid.sum()))

# --- 3. the iris disc: every patch stacked in iris-centred coordinates
PAD = 60
IW, IH = W + 2 * PAD, H + 2 * PAD
acc = np.zeros((N, IH, IW, 3)); val = np.zeros((N, IH, IW), bool); iri = np.zeros((N, IH, IW), bool)
masks = {}
for i, d in enumerate(DIRS):
    dx, dy = off[d]; img = P[d]
    ok = solid & ~dilate(lid, 1) & (depth >= 2)
    masks[d] = ((sat(img) > 55) | (lum(img) < 135)) & solid & ~lid
    ys, xs = np.nonzero(ok)
    acc[i, ys - dy + PAD, xs - dx + PAD] = img[ys, xs, :3]; val[i, ys - dy + PAD, xs - dx + PAD] = True
    ys, xs = np.nonzero(ok & masks[d]); iri[i, ys - dy + PAD, xs - dx + PAD] = True
n_val, n_iri = val.sum(0), iri.sum(0)
body = (n_val >= 1) & (n_iri * 2 > n_val)
# largest connected blob, then fill its holes (the highlights are white, so colour alone calls them "not iris")
def largest(mask):
    lab = np.zeros(mask.shape, int); cur = 0; best = (0, 0)
    for sy, sx in zip(*np.nonzero(mask)):
        if lab[sy, sx]: continue
        cur += 1; stack = [(sy, sx)]; lab[sy, sx] = cur; n = 0
        while stack:
            y, x = stack.pop(); n += 1
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < mask.shape[0] and 0 <= xx < mask.shape[1] and mask[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = cur; stack.append((yy, xx))
        if n > best[0]: best = (n, cur)
    return lab == best[1]
body = largest(body)
outside = largest(~np.pad(body, 1))[1:-1, 1:-1]
disc = ~outside
ys, xs = np.nonzero(disc)
# an ellipse through the blob's extent: the clean outline (the stacked edge is ragged where few patches show it)
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
rx, ry = (xs.max() - xs.min() + 1) / 2, (ys.max() - ys.min() + 1) / 2
print(f'iris disc: centre {cx - PAD:.1f},{cy - PAD:.1f} (patch coords at neutral), radii {rx:.1f} x {ry:.1f}')
yy, xx = np.mgrid[0:IH, 0:IW]
SS = 4                                        # anti-aliased ellipse edge
sub = (np.arange(SS) + 0.5) / SS - 0.5
cover = np.zeros((IH, IW))
for sy in sub:
    for sx in sub:
        cover += (((xx + sx - cx) / rx) ** 2 + ((yy + sy - cy) / ry) ** 2 <= 1)
cover /= SS * SS
inside = cover > 0
col = np.zeros((IH, IW, 3)); got = np.zeros((IH, IW), bool)
for y, x in zip(*np.nonzero(inside)):
    v = iri[:, y, x] if iri[:, y, x].sum() * 2 > val[:, y, x].sum() else val[:, y, x]
    if v.any(): col[y, x] = np.median(acc[v, y, x], axis=0); got[y, x] = True
need = inside & ~got
print('iris pixels no patch shows:', int(need.sum()))
while need.any():
    todo = need & dilate(got, 1)
    if not todo.any(): break
    for y, x in zip(*np.nonzero(todo)):
        y0, y1, x0, x1 = max(0, y - 1), y + 2, max(0, x - 1), x + 2
        col[y, x] = col[y0:y1, x0:x1][got[y0:y1, x0:x1]].mean(0)
    got |= todo; need &= ~todo
# the painted iris has a dark ink rim; stacking softens it, so draw it back along the ellipse (not across the highlight)
INK_RIM = np.array([38.0, 22.0, 48.0])
q = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
rim = np.clip((2.7 - (1 - q) * min(rx, ry)) / 1.2, 0, 1) * 0.92
rim = np.where(col @ np.array([0.299, 0.587, 0.114]) > 200, 0, rim) * inside
col = col * (1 - rim[..., None]) + INK_RIM * rim[..., None]
bx0, by0, bx1, by1 = int(np.floor(cx - rx)) - 1, int(np.floor(cy - ry)) - 1, int(np.ceil(cx + rx)) + 2, int(np.ceil(cy + ry)) + 2
iris = np.dstack([col, cover * 255])[by0:by1, bx0:bx1]
Image.fromarray(np.clip(iris, 0, 255).astype(np.uint8), 'RGBA').save(os.path.join(OUT, 'gaze_iris.png'))
iris_x, iris_y = bx0 - PAD, by0 - PAD

# --- 4. the eye white: each patch with its iris and lid lines removed, median of what is left
stack = np.stack([P[d][..., :3] for d in DIRS])                      # N,H,W,3
keep = np.stack([(P[d][..., 3] >= 250) & ~dilate(masks[d], 2) & ~lid for d in DIRS])
white = np.zeros((H, W, 3)); have = keep.any(0)
for y, x in zip(*np.nonzero(have)): white[y, x] = np.median(stack[keep[:, y, x], y, x], axis=0)
edge = (opening > 0) & ~solid                                         # the soft rim of the opening: same in every patch
for y, x in zip(*np.nonzero(edge)):
    a = np.array([P[d][y, x, 3] for d in DIRS]); white[y, x] = np.median(stack[a > 0, y, x], axis=0)
have |= edge
need = (opening > 0) & ~have
print('eye white: pixels never seen without iris:', int(need.sum()))
while need.any():
    todo = need & dilate(have & ~edge, 1)
    if not todo.any(): todo = need & dilate(have, 1)
    if not todo.any(): break
    for y, x in zip(*np.nonzero(todo)):
        y0, y1, x0, x1 = max(0, y - 1), y + 2, max(0, x - 1), x + 2
        m = (have & ~lid)[y0:y1, x0:x1]
        white[y, x] = white[y0:y1, x0:x1][m].mean(0) if m.any() else white[y, x]
    have |= todo; need &= ~todo
Image.fromarray(np.clip(np.dstack([white, opening]), 0, 255).astype(np.uint8), 'RGBA').save(os.path.join(OUT, 'gaze_white.png'))

# --- 5. the lid lines, drawn over the iris
lidcol = np.median(stack, axis=0)
Image.fromarray(np.clip(np.dstack([lidcol, lid * opening]), 0, 255).astype(np.uint8), 'RGBA').save(os.path.join(OUT, 'gaze_lid.png'))

data = {'x': X, 'y': Y, 'w': W, 'h': H, 'irisX': int(iris_x), 'irisY': int(iris_y), 'irisW': int(bx1 - bx0), 'irisH': int(by1 - by0),
        'offset': {d: [int(off[d][0]), int(off[d][1])] for d in DIRS}}
print('window.GAZE_SMOOTH =', json.dumps(data))
if not CHECK: sys.exit(0)
os.makedirs(CHECK, exist_ok=True)

# --- 6. check sheet: painted original | rebuilt from the layers, for the neutral eye and all 8 directions, + in-betweens
Z = 4
Wl, Il, Ll = (Image.open(os.path.join(OUT, n)) for n in ('gaze_white.png', 'gaze_iris.png', 'gaze_lid.png'))
def compose(dx, dy):
    wa = np.asarray(Wl).astype(float)
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0)); layer.paste(Il, (iris_x + int(round(dx)), iris_y + int(round(dy))), Il)
    la = np.asarray(layer).astype(float); a = la[..., 3:4] / 255
    out = wa.copy(); out[..., :3] = wa[..., :3] * (1 - a) + la[..., :3] * a          # source-atop: stays inside the opening
    ld = np.asarray(Ll).astype(float); a = ld[..., 3:4] / 255
    out[..., :3] = out[..., :3] * (1 - a) + ld[..., :3] * a
    return Image.fromarray(out.astype(np.uint8), 'RGBA')
cells = [('c', (0, 0))] + [(d, off[d]) for d in DIRS]
sheet = Image.new('RGBA', (4 * (W * Z + 8), 6 * (H * Z + 8)), (120, 160, 120, 255))
for i, (d, o) in enumerate(cells):
    orig = Image.fromarray((center if d == 'c' else P[d]).astype(np.uint8), 'RGBA')
    c0, row = (i % 2) * 2, i // 2
    for k, im in enumerate([orig, compose(*o)]):
        big = im.resize((W * Z, H * Z), Image.NEAREST); sheet.paste(big, ((c0 + k) * (W * Z + 8), row * (H * Z + 8)), big)
for k, t in enumerate([0.25, 0.5, 0.75]):                            # in-between positions no painted patch has
    a, b = np.array(off['r']), np.array(off['d']); o = (a + b) / 2 * 0 + (a * (1 - t) + b * t)
    big = compose(*o).resize((W * Z, H * Z), Image.NEAREST); sheet.paste(big, ((k + 1) * (W * Z + 8), 5 * (H * Z + 8)), big)
sheet.save(os.path.join(CHECK, 'check.png'))
