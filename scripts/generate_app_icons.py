#!/usr/bin/env python3
"""由品牌源图派生全套应用图标（时纪流 / ChronoFlow）。

**品牌标记沿用旧 ChronoFlow 的「时纪」字标**——细白描边圆头笔画、近黑底 `#21221D`。
源图 `app/assets/brand/mark-1024.png` 直接取自旧仓库：

    github.com/XAXinAn/ChronoFlow
      frontend/assets/AppIcons/Assets.xcassets/AppIcon.appiconset/_/1024.png
      （与同目录 appstore.png 字节相同）

为什么不自己画：品牌标记是既有资产，重画一版必然走形；整个 ChronoFlow 生态（旧前端、
邮件发件别名、短信签名）都用这一个标记，新一版要延续它。
注意源图写的是**两个字「时纪」**，而软件名是三个字「时纪流」——这是刻意的：
标记当作图形资产沿用，名称变化不跟着改标记（要改标记得先有设计稿）。

产出（默认写进 app/assets/）：

    icon.png            1024×1024 RGB，无 alpha —— 构建用 + 商店上传用（iOS 要求无透明）
    adaptive-icon.png   1024×1024 RGBA  —— Android 自适应图标前景（透明底 + 缩进安全圆的标记）
    splash.png          1024×1024 RGB   —— 启动图：白底 + 深色标记
    store/icon-512.png   512×512 RGB    —— 应用宝/部分商店要求 512×512

用法：

    pip install pillow
    python3 scripts/generate_app_icons.py
    python3 scripts/generate_app_icons.py --source <新标记.png> --out /tmp/icons   # 换标记时
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image

#: 品牌底色（从源图四角取样得到：RGB(33,34,29)，近黑带一点暖调）
BRAND_BACKGROUND = (33, 34, 29)
PAPER = (255, 255, 255)

#: 背景亮度上限与笔画亮度下限之间的渐变带：用来把抗锯齿边缘抠干净，
#: 同时保证源图背景上那层极淡的光晕（亮度 48~199 的零星像素）不会变成灰边。
BACKDROP_MAX = 60
STROKE_MIN = 170


def build_mask(source: Image.Image) -> Image.Image:
    """从源图里提取「笔画」的 alpha 掩膜（白笔画 → 255，背景 → 0）。"""
    rgb = source.convert("RGB")
    mask = Image.new("L", rgb.size)
    src, dst = rgb.load(), mask.load()
    width, height = rgb.size
    span = STROKE_MIN - BACKDROP_MAX
    for y in range(height):
        for x in range(width):
            luminance = max(src[x, y])  # 笔画是近白，取通道最大值最稳
            if luminance <= BACKDROP_MAX:
                dst[x, y] = 0
            elif luminance >= STROKE_MIN:
                dst[x, y] = 255
            else:
                dst[x, y] = int((luminance - BACKDROP_MAX) * 255 / span)
    return mask


def content_box(mask: Image.Image) -> tuple[int, int, int, int]:
    """标记的实际包围盒：后面按它做等比缩放与居中，避免把源图的留白也一起缩放。"""
    box = mask.getbbox()
    if box is None:
        raise SystemExit("源图里没有找到任何笔画，检查阈值或换一张源图")
    return box


def place_mark(
    mask: Image.Image,
    size: int,
    *,
    max_half_diagonal: float,
    color: tuple[int, int, int],
    background: tuple[int, int, int] | None,
) -> Image.Image:
    """把标记等比缩放后居中放进 size×size 画布。

    ``max_half_diagonal`` 是**标记半对角线**占画布的比例上限：Android 自适应图标会被裁成
    圆形/圆角方形，只按宽度缩放会导致两个端点被切掉，必须按对角线约束。
    """
    left, top, right, bottom = content_box(mask)
    mark = mask.crop((left, top, right, bottom))
    half_diagonal_ratio = math.hypot(mark.width, mark.height) / 2 / max(mark.width, mark.height)
    # 先把标记放大到「宽度 = 画布」得到基准，再按对角线约束缩回去
    scale = size / mark.width
    scale = min(
        scale,
        max_half_diagonal * size * 2 / math.hypot(mark.width, mark.height),
    )
    target = (max(1, round(mark.width * scale)), max(1, round(mark.height * scale)))
    mark = mark.resize(target, Image.LANCZOS)
    assert half_diagonal_ratio > 0  # 只为说明上面那步在算什么，不参与逻辑

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0) if background is None else background + (255,))
    layer = Image.new("RGBA", target, color + (255,))
    canvas.paste(layer, ((size - target[0]) // 2, (size - target[1]) // 2), mark)
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser(description="由品牌源图派生应用图标")
    parser.add_argument("--source", default="app/assets/brand/mark-1024.png", help="品牌标记源图")
    parser.add_argument("--out", default="app/assets", help="输出目录（默认 app/assets）")
    parser.add_argument("--size", type=int, default=1024, help="图标边长（默认 1024）")
    args = parser.parse_args()

    source = Image.open(args.source)
    mask = build_mask(source)
    out = Path(args.out)
    (out / "store").mkdir(parents=True, exist_ok=True)

    # 1) 应用图标：直接用品牌源图，只去掉 alpha 通道——iOS 的应用图标不允许透明。
    #    （源图本身 alpha 全 255，这里只是把通道砍掉，像素颜色一字不改。）
    icon = Image.new("RGB", source.size, BRAND_BACKGROUND)
    icon.paste(source.convert("RGB"), (0, 0))
    icon = icon.resize((args.size, args.size), Image.LANCZOS)
    icon.save(out / "icon.png")

    # 2) Android 自适应图标前景：透明底，标记缩到安全圆内（外围会被系统裁掉）
    adaptive = place_mark(
        mask, args.size * 4,
        max_half_diagonal=0.30,
        color=PAPER,
        background=None,
    ).resize((args.size, args.size), Image.LANCZOS)
    adaptive.save(out / "adaptive-icon.png")

    # 3) 启动图：白底 + 深色标记（与 app.json 的 splash.backgroundColor 一致）
    splash = place_mark(
        mask, args.size * 4,
        max_half_diagonal=0.22,
        color=BRAND_BACKGROUND,
        background=PAPER,
    ).convert("RGB").resize((args.size, args.size), Image.LANCZOS)
    splash.save(out / "splash.png")

    # 4) 商店素材：应用宝等要求 512×512
    icon.resize((512, 512), Image.LANCZOS).save(out / "store" / "icon-512.png")

    for path in sorted(out.rglob("*.png")):
        with Image.open(path) as image:
            print(
                f"{path}  {image.size[0]}×{image.size[1]}  {image.mode}"
                f"  {path.stat().st_size} bytes"
            )


if __name__ == "__main__":
    main()
