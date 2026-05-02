"""
Render public/icon-192.png and public/icon-512.png at native pixel
resolution. Each canvas size gets its own integer-pixel stripe layout
— nothing is generated at a small reference size and scaled up, so
edges land exactly on pixel boundaries and the tartan stays crisp at
both PWA sizes.

Layout source: a 32-unit reference grid (matches the sidebar SVG).
Stripe widths/positions are scaled to the target canvas, then floored
to integers and adjusted so no two adjacent stripes overlap or leave
gaps from rounding. Composition uses ImageDraw.rectangle (no
anti-aliasing on edges) on per-color RGBA layers, then blends with
explicit per-stripe opacities.

The "C" glyph keeps its anti-aliased text rendering — sharp tartan,
smooth letter — and a low-alpha dark halo for legibility over the
busiest crossings.

Run: `python scripts/gen-icons.py`
"""

from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

NAVY = (0x1B, 0x3A, 0x5C)
GREEN = (0x2D, 0x5A, 0x3A)
RED = (0xB8, 0x32, 0x32)
BLACK = (0x14, 0x14, 0x14)
GOLD = (0xC4, 0xA3, 0x5A)

# Stripes expressed in the 32-unit reference grid the sidebar SVG uses.
# We scale each (start, end) pair to the native canvas size with int()
# clamping so widths stay >= 1 even at the smallest icon size.
HORIZONTAL = [
    # (y_start, y_end, color, opacity)
    (2, 4, GOLD, 0.55),
    (7, 10, GREEN, 0.50),
    (13, 18, BLACK, 0.55),
    (21, 24, RED, 0.55),
    (27, 29, GOLD, 0.55),
]
VERTICAL = [
    # (x_start, x_end, color, opacity)
    (3, 5, GOLD, 0.40),
    (9, 12, GREEN, 0.40),
    (15, 20, BLACK, 0.45),
    (23, 26, RED, 0.40),
    (29, 31, GOLD, 0.40),
]


def to_native(start: int, end: int, canvas: int) -> tuple[int, int]:
    """Map a 0..32 reference range to integer 0..canvas pixel range."""
    a = round(start * canvas / 32)
    b = round(end * canvas / 32)
    if b <= a:
        b = a + 1
    return a, b


def find_font(size: int) -> ImageFont.FreeTypeFont:
    """Find a JetBrains-Mono-shaped fallback. We try the real font
    first, then Consolas (ships with Windows; closest mono shape),
    then DejaVu / Courier as a last resort."""
    candidates = [
        "JetBrainsMono-Bold.ttf",
        "JetBrainsMono-SemiBold.ttf",
        "JetBrainsMono-Medium.ttf",
        "consolab.ttf",  # Consolas Bold
        "consola.ttf",   # Consolas regular
        "DejaVuSansMono-Bold.ttf",
        "Courier New Bold.ttf",
        "cour.ttf",
    ]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except (IOError, OSError):
            continue
    return ImageFont.load_default()


def render(canvas: int, out: Path) -> None:
    """Draw a tartan + 'C' icon at exactly canvas×canvas pixels."""
    # Opaque navy ground.
    img = Image.new("RGBA", (canvas, canvas), NAVY + (255,))

    # Horizontal stripes (warp). Each stripe paints onto a temp RGBA
    # layer so the global Image.alpha_composite can apply the per-
    # stripe opacity uniformly. ImageDraw.rectangle is single-sample
    # (no edge AA) so left/right edges land exactly on pixel columns.
    for y0, y1, color, alpha in HORIZONTAL:
        a, b = to_native(y0, y1, canvas)
        layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rectangle(
            (0, a, canvas - 1, b - 1),
            fill=color + (int(round(alpha * 255)),),
        )
        img = Image.alpha_composite(img, layer)

    # Vertical stripes (weft).
    for x0, x1, color, alpha in VERTICAL:
        a, b = to_native(x0, x1, canvas)
        layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rectangle(
            (a, 0, b - 1, canvas - 1),
            fill=color + (int(round(alpha * 255)),),
        )
        img = Image.alpha_composite(img, layer)

    # Round the corners — same 8/32 ratio the sidebar uses (= canvas/4).
    radius = canvas // 4
    mask = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, canvas - 1, canvas - 1), radius=radius, fill=255
    )

    # Anti-aliased white "C" with a subtle dark halo.
    font_size = canvas // 2
    font = find_font(font_size)
    text = "C"
    glyph_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glyph_layer)
    bbox = draw.textbbox((0, 0), text, font=font, anchor="lt")
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (canvas - text_w) // 2 - bbox[0]
    y = (canvas - text_h) // 2 - bbox[1]
    halo_alpha = 140
    stroke_w = max(1, canvas // 256)
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255),
              stroke_width=stroke_w, stroke_fill=(0x14, 0x14, 0x14, halo_alpha))
    img = Image.alpha_composite(img, glyph_layer)

    out_img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out_img.paste(img, mask=mask)
    out.parent.mkdir(parents=True, exist_ok=True)
    out_img.save(out, format="PNG", optimize=True)
    print(f"  wrote {out} ({canvas}×{canvas})")


def main() -> None:
    here = Path(__file__).resolve().parent.parent
    public = here / "public"
    print("Rendering Carnegie tartan icons:")
    render(192, public / "icon-192.png")
    render(512, public / "icon-512.png")


if __name__ == "__main__":
    main()
