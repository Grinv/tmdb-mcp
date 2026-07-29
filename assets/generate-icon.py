#!/usr/bin/env python3
"""Regenerate assets/icon.png from the design in icon-source.svg.

Not part of the npm build — this is a one-off design asset, run manually
whenever the icon needs to change. Requires Pillow (`pip install pillow`).

Renders directly with Pillow instead of an SVG->PNG pipeline: both a
Chrome/chrome-devtools screenshot and macOS Quick Look's SVG thumbnailer
silently composite the transparent background against opaque white,
which Anthropic's MCPB icon spec explicitly requires ("PNG with
transparency" - see claude.com/docs/connectors/building/mcpb). Drawing
directly gives real per-pixel alpha with no compositing step to lose it.

Keep the geometry/gradient stops here in sync with icon-source.svg by hand
if you ever edit one — there's no automated link between the two.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "icon.png"

SIZE = 512
SCALE = 4  # supersample then downsample for anti-aliased edges (Pillow's
           # ImageDraw has no native AA)
STROKE = 52  # matches icon-source.svg's stroke-width
VERTS = [(156, 110), (156, 402), (400, 256)]  # matches icon-source.svg's path
# exact 3-stop gradient from TMDB's own wordmark SVG (themoviedb.org's
# blue_short-*.svg asset), left to right
STOPS = [(0.0, (0x90, 0xCE, 0xA1)), (0.56, (0x3C, 0xBE, 0xC9)), (1.0, (0x00, 0xB3, 0xE5))]


def lerp_color(t, stops):
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t0 <= t <= t1 or i == len(stops) - 2:
            local_t = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            local_t = max(0.0, min(1.0, local_t))
            return tuple(round(c0[ch] + (c1[ch] - c0[ch]) * local_t) for ch in range(3))
    return stops[-1][1]


def main():
    w = h = SIZE * SCALE
    stroke = STROKE * SCALE
    verts = [(x * SCALE, y * SCALE) for x, y in VERTS]

    # alpha mask: filled triangle + a thick closed round-joined stroke along
    # its edges, plus a circle at each vertex (mirrors an SVG round linejoin,
    # which ImageDraw's line(joint="curve") only applies at interior joins).
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.polygon(verts, fill=255)
    d.line(verts + [verts[0]], fill=255, width=stroke, joint="curve")
    for x, y in verts:
        r = stroke / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)

    # horizontal gradient, scoped to the shape's own dilated bounding box —
    # matches the SVG gradient's default objectBoundingBox units (x1=0/x2=1
    # relative to the shape, not the full canvas).
    x0, y0, x1, y1 = mask.getbbox()
    grad = Image.new("RGB", (w, h))
    gpix = grad.load()
    span = max(1, x1 - x0)
    for x in range(x0, x1):
        col = lerp_color((x - x0) / span, STOPS)
        for y in range(y0, y1):
            gpix[x, y] = col

    big = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    big.paste(grad, (0, 0), mask)

    out = big.resize((SIZE, SIZE), Image.LANCZOS)
    out.save(OUT)
    print(f"wrote {OUT} ({out.size[0]}x{out.size[1]}, mode={out.mode})")


if __name__ == "__main__":
    main()
