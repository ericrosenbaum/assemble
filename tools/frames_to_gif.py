#!/usr/bin/env python3
"""Assemble captured PNG frames into a palette-quantized animated GIF.

    python3 tools/frames_to_gif.py out/run1 results/run1.gif --fps 20 [--holdlast 12]
"""

import argparse
import glob
import os
import sys

from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("framedir")
    ap.add_argument("out")
    ap.add_argument("--fps", type=float, default=20)
    ap.add_argument("--holdlast", type=int, default=10, help="repeat final frame N times")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--stride", type=int, default=1, help="use every Nth frame")
    ap.add_argument("--colors", type=int, default=128)
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.framedir, "frame_*.png")))
    if not files:
        sys.exit(f"no frames in {args.framedir}")
    files = files[:: args.stride] + ([files[-1]] if (len(files) - 1) % args.stride else [])

    frames = []
    for f in files:
        im = Image.open(f).convert("RGB")
        if args.scale != 1.0:
            im = im.resize((int(im.width * args.scale), int(im.height * args.scale)), Image.LANCZOS)
        frames.append(im.quantize(colors=args.colors, method=Image.MEDIANCUT, dither=Image.NONE))
    frames += [frames[-1]] * args.holdlast

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    dur = int(1000 / args.fps)
    frames[0].save(
        args.out,
        save_all=True,
        append_images=frames[1:],
        duration=dur,
        loop=0,
        optimize=True,
    )
    size = os.path.getsize(args.out)
    print(f"{args.out}: {len(frames)} frames, {size/1e6:.2f} MB")


if __name__ == "__main__":
    main()
