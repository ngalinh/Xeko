"""Generate Xeko PWA icons (option B: avatar on purple gradient tile).

Produces:
 - xeko-icon-192.png   (manifest "any")
 - xeko-icon-512.png   (manifest "any", also used as splash)
 - xeko-icon-maskable-512.png  (safe-zone padding for Android adaptive)
 - apple-touch-icon.png (180x180, solid bg for iOS)
 - xeko-icon-preview.png (same as 512 for user preview)
"""
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

ROOT = Path(__file__).parent.parent   # project root
AVATAR = Image.open(ROOT / 'xeko-avatar.png').convert('RGBA')

# Brand colors — match lavender/purple theme (#7c66ff → #a78bfa)
GRAD_TOP = (124, 102, 255)
GRAD_BOT = (167, 139, 250)


def rounded_square(size: int, radius_ratio: float = 0.22) -> Image.Image:
    """Return RGBA image with rounded-corner gradient tile."""
    # 1. gradient (vertical)
    grad = Image.new('RGB', (size, size), GRAD_TOP)
    top_r, top_g, top_b = GRAD_TOP
    bot_r, bot_g, bot_b = GRAD_BOT
    px = grad.load()
    for y in range(size):
        t = y / (size - 1)
        r = int(top_r + (bot_r - top_r) * t)
        g = int(top_g + (bot_g - top_g) * t)
        b = int(top_b + (bot_b - top_b) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    # 2. rounded-corner alpha mask
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    draw.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=r, fill=255)
    tile = Image.new('RGBA', (size, size))
    tile.paste(grad, (0, 0))
    tile.putalpha(mask)
    return tile


def composite_avatar(tile: Image.Image, avatar_scale: float = 0.88) -> Image.Image:
    """Paste avatar centered, scaled — no extra glow (avatar already has
    teal disc in source PNG)."""
    size = tile.size[0]
    av_size = int(size * avatar_scale)
    av = AVATAR.resize((av_size, av_size), Image.LANCZOS)
    out = tile.copy()
    ox = (size - av_size) // 2
    oy = (size - av_size) // 2
    out.alpha_composite(av, (ox, oy))
    return out


def save(img: Image.Image, name: str):
    path = ROOT / name
    img.save(path, optimize=True)
    print(f'  wrote {name} ({img.size[0]}×{img.size[1]}, {path.stat().st_size // 1024} KB)')


# --- Generate ---
print('Generating icons...')

# Manifest "any" — 192 & 512 with full gradient tile
for size in (192, 512):
    tile = rounded_square(size, radius_ratio=0.22)
    icon = composite_avatar(tile, avatar_scale=0.80)
    save(icon, f'xeko-icon-{size}.png')

# Maskable — pad extra for safe zone (Android adaptive icons crop to circle)
tile_m = rounded_square(512, radius_ratio=0.50)  # near-circle
icon_m = composite_avatar(tile_m, avatar_scale=0.60)  # smaller, inside safe zone
save(icon_m, 'xeko-icon-maskable-512.png')

# iOS apple-touch-icon (180x180, no rounded corners — iOS masks itself)
ios_tile = rounded_square(180, radius_ratio=0.22)
# iOS ignores alpha around rounded corners and masks itself; fill full square
full = Image.new('RGBA', (180, 180))
# paint gradient without rounded mask so iOS can round to its own radius
grad = Image.new('RGB', (180, 180), GRAD_TOP)
px = grad.load()
for y in range(180):
    t = y / 179
    r = int(124 + (167 - 124) * t)
    g = int(102 + (139 - 102) * t)
    b = int(255 + (250 - 255) * t)
    for x in range(180):
        px[x, y] = (r, g, b)
full.paste(grad, (0, 0))
full.putalpha(255)
ios = composite_avatar(full, avatar_scale=0.80)
save(ios, 'apple-touch-icon.png')

# Preview copy for user
save(Image.open(ROOT / 'xeko-icon-512.png'), 'xeko-icon-preview.png')
print('Done.')
