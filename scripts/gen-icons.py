"""
Render public/icon-192.png and public/icon-512.png to match the
sidebar TartanLogo. The renderer mirrors the SVG version in
components/Tartan.tsx — same five clan colors, same warp/weft layering
proportions (16x scaled at 512, 6x at 192), same 8-px sidebar
border-radius scaled proportionally (rx = canvas/4).

PIL doesn't have rect-with-rounded-corners + alpha-aware compositing
out of the box, so we build the tartan on an opaque RGBA canvas, then
mask it through a rounded-rect alpha layer at the end so the output
PNG carries true transparency outside the rounded corners.

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

# Stripe geometry expressed in the 32-unit reference grid that the SVG
# version uses; this script scales every coordinate to the requested
# canvas size so the visual layout of the small SVG and the rendered
# PNG line up exactly.
HORIZONTAL = [
    # (y, height, color, opacity)
    (2, 2, GOLD, 0.55),
    (7, 3, GREEN, 0.50),
    (13, 5, BLACK, 0.55),
    (21, 3, RED, 0.55),
    (27, 2, GOLD, 0.55),
]
VERTICAL = [
    # (x, width, color, opacity)
    (3, 2, GOLD, 0.40),
    (9, 3, GREEN, 0.40),
    (15, 5, BLACK, 0.45),
    (23, 3, RED, 0.40),
    (29, 2, GOLD, 0.40),
]


def blend(base: tuple[int, int, int], over: tuple[int, int, int], alpha: float) -> tuple[int, int, int]:
    """Source-over blend a single opaque-RGB color over the base."""
    return tuple(int(round(b * (1 - alpha) + o * alpha)) for b, o in zip(base, over))


def find_font(size: int) -> ImageFont.FreeTypeFont:
    """Find a JetBrains-Mono-shaped fallback. Most desktops have it
    after we loaded it via Google Fonts in dev; on a build server we
    fall back to a stock monospace font that ships with PIL.
    """
    candidates = [
        "JetBrainsMono-Bold.ttf",
        "JetBrainsMono-SemiBold.ttf",
        "JetBrainsMono-Medium.ttf",
        "consola.ttf",  # Consolas, ships with Windows
        "consolab.ttf",  # Consolas Bold
        "DejaVuSansMono-Bold.ttf",
        "Courier New Bold.ttf",
        "cour.ttf",
    ]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except (IOError, OSError):
            continue
    # Last resort — the built-in PIL bitmap font; not pretty at large
    # sizes but won't fail.
    return ImageFont.load_default()


def render(canvas: int, out: Path) -> None:
    scale = canvas / 32
    img = Image.new("RGBA", (canvas, canvas), NAVY + (255,))
    draw = ImageDraw.Draw(img)

    # Horizontal stripes (warp).
    for y, h, color, alpha in HORIZONTAL:
        y_px = int(round(y * scale))
        h_px = int(round(h * scale))
        for row in range(y_px, min(canvas, y_px + h_px)):
            for col in range(canvas):
                base = img.getpixel((col, row))[:3]
                img.putpixel((col, row), blend(base, color, alpha) + (255,))

    # Vertical stripes (weft).
    for x, w, color, alpha in VERTICAL:
        x_px = int(round(x * scale))
        w_px = int(round(w * scale))
        for col in range(x_px, min(canvas, x_px + w_px)):
            for row in range(canvas):
                base = img.getpixel((col, row))[:3]
                img.putpixel((col, row), blend(base, color, alpha) + (255,))

    # White "C" glyph with a faint dark halo so it stays readable over
    # the busiest tartan crossings. Position matches the SVG's
    # text-anchor=middle, y=22 of 32 baseline.
    font_size = int(round(16 * scale))
    font = find_font(font_size)
    text = "C"
    # Center the glyph on the canvas. textbbox returns left/top/right/
    # bottom in the destination coordinate space.
    bbox = draw.textbbox((0, 0), text, font=font, anchor="lt")
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (canvas - text_w) // 2 - bbox[0]
    y = (canvas - text_h) // 2 - bbox[1]

    # Halo: stroke around the glyph at low opacity.
    halo_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    halo_draw = ImageDraw.Draw(halo_layer)
    halo_color = (0x14, 0x14, 0x14, 140)
    stroke_w = max(1, int(round(0.7 * scale)))
    halo_draw.text((x, y), text, font=font, fill=halo_color,
                   stroke_width=stroke_w, stroke_fill=halo_color)
    img = Image.alpha_composite(img, halo_layer)

    # White glyph on top.
    glyph_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    glyph_draw = ImageDraw.Draw(glyph_layer)
    glyph_draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    img = Image.alpha_composite(img, glyph_layer)

    # Round the corners — same 8/32 ratio the SVG uses.
    radius = int(round(canvas / 4))
    mask = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, canvas - 1, canvas - 1), radius=radius, fill=255
    )
    out_img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out_img.paste(img, mask=mask)

    out.parent.mkdir(parents=True, exist_ok=True)
    out_img.save(out, format="PNG", optimize=True)
    print(f"  wrote {out} ({canvas}x{canvas}, font={font.path if hasattr(font, 'path') else 'default'})")


def main() -> None:
    here = Path(__file__).resolve().parent.parent
    public = here / "public"
    print("Rendering Carnegie tartan icons:")
    render(192, public / "icon-192.png")
    render(512, public / "icon-512.png")


if __name__ == "__main__":
    main()
