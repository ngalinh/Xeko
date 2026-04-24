"""Generate 4 icon design previews (512×512) for Xeko PWA.

Saves into tools/preview/ so user can compare:
 - opt1-avatar-clean.png   : Avatar on gradient tile (no glow, big scale)
 - opt2-monogram-X.png     : Bold "X" wordmark on gradient (iOS-style)
 - opt3-wordmark-Xeko.png  : "Xeko" wordmark
 - opt4-avatar-circle.png  : Avatar inside white circle on purple tile (cleaner separation)
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from pathlib import Path

ROOT = Path(__file__).parent.parent
OUT = Path(__file__).parent / 'preview'
OUT.mkdir(exist_ok=True)
AVATAR = Image.open(ROOT / 'xeko-avatar.png').convert('RGBA')

GRAD_TOP = (124, 102, 255)
GRAD_BOT = (167, 139, 250)
SIZE = 512


def gradient(w, h, top, bot):
    g = Image.new('RGB', (w, h), top)
    px = g.load()
    for y in range(h):
        t = y / (h - 1)
        px_row = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = px_row
    return g


def rounded(size: int, radius_ratio=0.22) -> Image.Image:
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


# ---- Option 1: Avatar clean (no glow, big scale) ----
t1 = rounded(SIZE)
av = AVATAR.resize((int(SIZE * 0.92), int(SIZE * 0.92)), Image.LANCZOS)
o = (SIZE - av.width) // 2
t1.alpha_composite(av, (o, o))
save(t1, 'opt1-avatar-clean.png')


# ---- Option 2: Bold monogram "X" ----
t2 = rounded(SIZE)
d = ImageDraw.Draw(t2)
# Try to find a bold font
font = None
for path in [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
]:
    if Path(path).exists():
        try:
            font = ImageFont.truetype(path, int(SIZE * 0.58))
            break
        except Exception:
            pass
if font is None:
    font = ImageFont.load_default()
text = 'X'
bbox = d.textbbox((0, 0), text, font=font)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
# draw subtle shadow
shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.text(((SIZE - tw) // 2 - bbox[0],
         (SIZE - th) // 2 - bbox[1] + int(SIZE * 0.015)),
        text, font=font, fill=(40, 20, 100, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(int(SIZE * 0.015)))
t2.alpha_composite(shadow)
d.text(((SIZE - tw) // 2 - bbox[0], (SIZE - th) // 2 - bbox[1]),
       text, font=font, fill=(255, 255, 255, 255))
save(t2, 'opt2-monogram-X.png')


# ---- Option 3: Wordmark "Xeko" ----
t3 = rounded(SIZE)
d = ImageDraw.Draw(t3)
if font:
    f3 = ImageFont.truetype(font.path, int(SIZE * 0.30))
else:
    f3 = ImageFont.load_default()
txt = 'Xeko'
bbox = d.textbbox((0, 0), txt, font=f3)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
d.text(((SIZE - tw) // 2 - bbox[0], (SIZE - th) // 2 - bbox[1]),
       txt, font=f3, fill=(255, 255, 255, 255))
save(t3, 'opt3-wordmark-Xeko.png')


# ---- Option 4: Avatar inside white circle on gradient tile ----
t4 = rounded(SIZE)
# White disc
disc_size = int(SIZE * 0.78)
disc = Image.new('RGBA', (disc_size, disc_size), (0, 0, 0, 0))
dd = ImageDraw.Draw(disc)
dd.ellipse([(0, 0), (disc_size - 1, disc_size - 1)], fill=(255, 255, 255, 255))
# drop shadow for disc
sh = Image.new('RGBA', (disc_size + 40, disc_size + 40), (0, 0, 0, 0))
sdd = ImageDraw.Draw(sh)
sdd.ellipse([(20, 28), (disc_size + 19, disc_size + 27)], fill=(60, 40, 130, 60))
sh = sh.filter(ImageFilter.GaussianBlur(14))
sx = (SIZE - sh.width) // 2
sy = (SIZE - sh.height) // 2
t4.alpha_composite(sh, (sx, sy))
dx = (SIZE - disc_size) // 2
dy = (SIZE - disc_size) // 2
t4.alpha_composite(disc, (dx, dy))
# Avatar inside disc (slightly smaller)
av4 = AVATAR.resize((int(SIZE * 0.66), int(SIZE * 0.66)), Image.LANCZOS)
# Mask avatar into disc area — simple centering since avatar includes teal bg
ax = (SIZE - av4.width) // 2
ay = (SIZE - av4.height) // 2 + int(SIZE * 0.01)
t4.alpha_composite(av4, (ax, ay))
save(t4, 'opt4-avatar-circle.png')

print('\nDone. Previews in:', OUT)
