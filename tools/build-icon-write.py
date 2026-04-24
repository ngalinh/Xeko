"""Generate icon previews with 'writing/posting' theme.

 - optA-pencil.png   : Big pencil/edit glyph on gradient
 - optB-paperplane.png : Send (paper plane) glyph
 - optC-chat-pencil.png : Speech bubble + pencil combo
 - optD-wordmark-pencil.png : "Xeko" + pencil underline
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import math

ROOT = Path(__file__).parent.parent
OUT = Path(__file__).parent / 'preview'
OUT.mkdir(exist_ok=True)

SIZE = 512
GRAD_TOP = (124, 102, 255)
GRAD_BOT = (167, 139, 250)
WHITE = (255, 255, 255, 255)


def gradient(w, h, top, bot):
    g = Image.new('RGB', (w, h), top)
    px = g.load()
    for y in range(h):
        t = y / (h - 1)
        row = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = row
    return g


def rounded(size=SIZE, radius_ratio=0.22):
    tile = Image.new('RGBA', (size, size))
    tile.paste(gradient(size, size, GRAD_TOP, GRAD_BOT), (0, 0))
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([(0, 0), (size - 1, size - 1)],
                        radius=int(size * radius_ratio), fill=255)
    tile.putalpha(mask)
    return tile


def save(img, name):
    path = OUT / name
    img.save(path, optimize=True)
    print(f'  {name} ({path.stat().st_size // 1024} KB)')


# ---- Option A: pencil/edit icon (solid white) ----
tA = rounded()
d = ImageDraw.Draw(tA)

# Paper (rounded rectangle, tilted slightly)
paper_w, paper_h = int(SIZE * 0.54), int(SIZE * 0.62)
paper_x = (SIZE - paper_w) // 2 - int(SIZE * 0.03)
paper_y = (SIZE - paper_h) // 2 + int(SIZE * 0.03)
paper = Image.new('RGBA', (paper_w + 30, paper_h + 30), (0, 0, 0, 0))
pd = ImageDraw.Draw(paper)
pd.rounded_rectangle([(15, 15), (15 + paper_w, 15 + paper_h)],
                     radius=int(SIZE * 0.03), fill=WHITE)
# paper lines
line_color = (200, 195, 230, 255)
for i in range(3):
    y = 15 + int(paper_h * (0.28 + 0.20 * i))
    pd.line([(15 + int(paper_w * 0.16), y),
             (15 + int(paper_w * 0.74), y)],
            fill=line_color, width=int(SIZE * 0.016))

# soft shadow under paper
sh = Image.new('RGBA', paper.size, (0, 0, 0, 0))
sd = ImageDraw.Draw(sh)
sd.rounded_rectangle([(18, 24), (18 + paper_w, 24 + paper_h)],
                     radius=int(SIZE * 0.03), fill=(40, 20, 90, 100))
sh = sh.filter(ImageFilter.GaussianBlur(14))
tA.alpha_composite(sh, (paper_x - 15, paper_y - 15))
tA.alpha_composite(paper, (paper_x - 15, paper_y - 15))

# Pencil (tilted 45°) on top-right of paper
pen_w, pen_h = int(SIZE * 0.56), int(SIZE * 0.10)
pen_layer = Image.new('RGBA', (pen_w + 40, pen_h + 40), (0, 0, 0, 0))
pd2 = ImageDraw.Draw(pen_layer)
# body
pd2.rounded_rectangle([(20, 20), (20 + pen_w - int(pen_w * 0.18), 20 + pen_h)],
                      radius=int(pen_h * 0.30), fill=(255, 210, 90, 255))
# metal ferrule
fx1 = 20 + pen_w - int(pen_w * 0.22)
pd2.rectangle([(fx1, 20), (fx1 + int(pen_w * 0.08), 20 + pen_h)],
              fill=(180, 180, 200, 255))
# tip (triangle)
tip_x = fx1 + int(pen_w * 0.08)
pd2.polygon([(tip_x, 20),
             (tip_x + int(pen_w * 0.14), 20 + pen_h // 2),
             (tip_x, 20 + pen_h)],
            fill=(255, 245, 220, 255))
# lead
pd2.polygon([(tip_x + int(pen_w * 0.10), 20 + int(pen_h * 0.35)),
             (tip_x + int(pen_w * 0.14), 20 + pen_h // 2),
             (tip_x + int(pen_w * 0.10), 20 + int(pen_h * 0.65))],
            fill=(30, 30, 50, 255))
# eraser on left
pd2.rounded_rectangle([(20 - int(pen_w * 0.02), 20),
                       (20 + int(pen_w * 0.10), 20 + pen_h)],
                      radius=int(pen_h * 0.25), fill=(255, 130, 150, 255))

pen_tilted = pen_layer.rotate(-35, resample=Image.BICUBIC, expand=True)
# place
px = (SIZE - pen_tilted.width) // 2 + int(SIZE * 0.10)
py = (SIZE - pen_tilted.height) // 2 - int(SIZE * 0.12)
tA.alpha_composite(pen_tilted, (px, py))
save(tA, 'optA-pencil.png')


# ---- Option B: paper plane (send) ----
tB = rounded()
# draw white paper plane
plane = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
pd = ImageDraw.Draw(plane)
# Main triangle
cx, cy = SIZE // 2, SIZE // 2
s = int(SIZE * 0.32)  # half size
# paper plane: arrow-like triangle pointing up-right
pd.polygon([
    (cx - s, cy + int(s * 0.4)),           # bottom-left
    (cx + int(s * 0.9), cy - int(s * 0.9)),# top-right tip
    (cx - int(s * 0.2), cy + int(s * 0.2)), # inner fold
], fill=WHITE)
# Wing under
pd.polygon([
    (cx - int(s * 0.2), cy + int(s * 0.2)),
    (cx + int(s * 0.9), cy - int(s * 0.9)),
    (cx + int(s * 0.1), cy + int(s * 0.55)),
], fill=(240, 235, 255, 255))
# shadow
shadow_layer = plane.copy()
shadow_pixels = shadow_layer.load()
for x in range(shadow_layer.width):
    for y in range(shadow_layer.height):
        r, g, b, a = shadow_pixels[x, y]
        if a > 0:
            shadow_pixels[x, y] = (40, 20, 90, a // 2)
shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(10))
tB.alpha_composite(shadow_layer, (6, 10))
tB.alpha_composite(plane, (0, 0))
save(tB, 'optB-paperplane.png')


# ---- Option C: chat bubble + pencil ----
tC = rounded()
d = ImageDraw.Draw(tC)
# Chat bubble (rounded rectangle with tail)
bw, bh = int(SIZE * 0.64), int(SIZE * 0.52)
bx = (SIZE - bw) // 2
by = (SIZE - bh) // 2 - int(SIZE * 0.04)
# soft shadow
sh = Image.new('RGBA', (bw + 40, bh + 40), (0, 0, 0, 0))
sd = ImageDraw.Draw(sh)
sd.rounded_rectangle([(20, 28), (20 + bw, 28 + bh)],
                     radius=int(SIZE * 0.10), fill=(40, 20, 90, 90))
sh = sh.filter(ImageFilter.GaussianBlur(14))
tC.alpha_composite(sh, (bx - 20, by - 20))

d.rounded_rectangle([(bx, by), (bx + bw, by + bh)],
                    radius=int(SIZE * 0.10), fill=WHITE)
# tail
tail_base_x = bx + int(bw * 0.22)
tail_tip_y = by + bh + int(SIZE * 0.10)
d.polygon([
    (tail_base_x, by + bh - 4),
    (tail_base_x + int(SIZE * 0.14), by + bh - 4),
    (tail_base_x + int(SIZE * 0.02), tail_tip_y),
], fill=WHITE)

# Pencil across bubble (tilted)
pen_w, pen_h = int(SIZE * 0.44), int(SIZE * 0.08)
pen_layer = Image.new('RGBA', (pen_w + 40, pen_h + 40), (0, 0, 0, 0))
pd2 = ImageDraw.Draw(pen_layer)
pd2.rounded_rectangle([(20, 20), (20 + pen_w - int(pen_w * 0.18), 20 + pen_h)],
                      radius=int(pen_h * 0.30),
                      fill=(124, 102, 255, 255))
fx1 = 20 + pen_w - int(pen_w * 0.22)
pd2.rectangle([(fx1, 20), (fx1 + int(pen_w * 0.08), 20 + pen_h)],
              fill=(180, 180, 200, 255))
tip_x = fx1 + int(pen_w * 0.08)
pd2.polygon([(tip_x, 20),
             (tip_x + int(pen_w * 0.14), 20 + pen_h // 2),
             (tip_x, 20 + pen_h)],
            fill=(255, 240, 200, 255))
pd2.polygon([(tip_x + int(pen_w * 0.10), 20 + int(pen_h * 0.35)),
             (tip_x + int(pen_w * 0.14), 20 + pen_h // 2),
             (tip_x + int(pen_w * 0.10), 20 + int(pen_h * 0.65))],
            fill=(40, 30, 80, 255))
pd2.rounded_rectangle([(20 - int(pen_w * 0.02), 20),
                       (20 + int(pen_w * 0.10), 20 + pen_h)],
                      radius=int(pen_h * 0.25), fill=(255, 130, 150, 255))
pen_tilted = pen_layer.rotate(-20, resample=Image.BICUBIC, expand=True)
tC.alpha_composite(pen_tilted,
                   ((SIZE - pen_tilted.width) // 2 + int(SIZE * 0.02),
                    (SIZE - pen_tilted.height) // 2 - int(SIZE * 0.05)))
save(tC, 'optC-chat-pencil.png')


# ---- Option D: wordmark "Xeko" + pencil underline ----
tD = rounded()
d = ImageDraw.Draw(tD)
font = None
for path in [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
]:
    if Path(path).exists():
        font = ImageFont.truetype(path, int(SIZE * 0.28))
        break
if font is None:
    font = ImageFont.load_default()
txt = 'Xeko'
bbox = d.textbbox((0, 0), txt, font=font)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
tx = (SIZE - tw) // 2 - bbox[0]
ty = (SIZE - th) // 2 - bbox[1] - int(SIZE * 0.04)
d.text((tx, ty), txt, font=font, fill=WHITE)

# Pencil underline (short, horizontal)
pen_w, pen_h = int(SIZE * 0.34), int(SIZE * 0.05)
pen_layer = Image.new('RGBA', (pen_w + 20, pen_h + 20), (0, 0, 0, 0))
pd2 = ImageDraw.Draw(pen_layer)
pd2.rounded_rectangle([(10, 10), (10 + pen_w - int(pen_w * 0.22), 10 + pen_h)],
                      radius=int(pen_h * 0.5), fill=(255, 220, 120, 255))
fx1 = 10 + pen_w - int(pen_w * 0.25)
pd2.rectangle([(fx1, 10), (fx1 + int(pen_w * 0.08), 10 + pen_h)],
              fill=(200, 200, 220, 255))
tip_x = fx1 + int(pen_w * 0.08)
pd2.polygon([(tip_x, 10),
             (tip_x + int(pen_w * 0.14), 10 + pen_h // 2),
             (tip_x, 10 + pen_h)],
            fill=(255, 245, 220, 255))
pd2.polygon([(tip_x + int(pen_w * 0.11), 10 + int(pen_h * 0.30)),
             (tip_x + int(pen_w * 0.14), 10 + pen_h // 2),
             (tip_x + int(pen_w * 0.11), 10 + int(pen_h * 0.70))],
            fill=(40, 30, 80, 255))

ux = (SIZE - pen_layer.width) // 2
uy = ty + th + int(SIZE * 0.03)
tD.alpha_composite(pen_layer, (ux, uy))
save(tD, 'optD-wordmark-pencil.png')

print('\nDone.')
