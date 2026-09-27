#!/usr/bin/env python3
"""生成 XaTodo 的应用图标（黑白极简的「X」字标）。

为什么用代码画而不是让 AI 生成：
商店对图标有硬性要求——**1024×1024、iOS 不能带 alpha 通道、Android 自适应图标要留安全区**，
而且要求同一个 mark 在图标 / 启动图 / 商店素材上是同一个形状。这些用几行几何代码就能精确保证，
还能改一个数字就重出全套（比例、描边、颜色都在下面的常量与命令行参数里）。

**这一版的造型是「粗细对比 + 圆头 + 大留白」**：两根对角线一粗一细（粗 .108 / 细 .062）。
前两版都不行，记下来免得再走一遍：
  ① 等粗粗笔画（.125）＝ 一个「关闭按钮」，与系统的 ✕ 图标没有区别；
  ② 等粗但整体变细（.085）＝ 优雅但依然是个普通 X；
  ③ 对比太弱（.102 / .074）＝ 看着像手抖，不像设计。
把对比拉到 .108 / .062 才既像字标又不像按钮。留白用 0.60（0.66 太满，0.52 又显得虚）。
小尺寸可用性用「128 / 64 / 48 / 32 px 阶梯图」验过：细笔画在 32px 下仍然分得出来，
**细到 .055 以下会在小尺寸糊掉**，别再调更细。

底色保持近黑、标是白色：白底图标在商店列表与浅色壁纸上会失去边界，
而深底白标在哪儿都有一个清晰的方块边界（启动图反过来用白底黑标，形成呼应）。

产出（默认写进 app/assets/）：

    icon.png            1024×1024 RGB，无 alpha —— 构建用 + 商店上传用（iOS 要求无透明）
    adaptive-icon.png   1024×1024 RGBA  —— Android 自适应图标前景，mark 缩到安全圆内
    splash.png          1024×1024 RGB   —— 启动图：白底 + 黑 X（与 app.json 的 splash 一致）
    store/icon-512.png   512×512 RGB    —— 应用宝/部分商店要求 512×512

用法：

    pip install pillow
    python3 scripts/generate_app_icons.py
    python3 scripts/generate_app_icons.py --out /tmp/icons --box 0.62 --stroke 0.11   # 试参数
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw

# 与 packages/design-tokens 保持一致：accent 是近黑，文本色是纯白
INK = (10, 10, 10)
PAPER = (255, 255, 255)

#: 超采样倍数：先按 4 倍画再降采样，边缘才不会有锯齿
SUPERSAMPLE = 4


def thick_line(draw: ImageDraw.ImageDraw, start, end, width: float, color) -> None:
    """带圆头的粗线段。

    PIL 的 ``line`` 只有方头（``joint='curve'`` 也只管拐角），因此这里手动画：
    四边形做躯干 + 两端各一个圆做圆头。圆头是这套设计语言的关键——
    X 的四个端点是视觉焦点，方的会显得生硬，而且更容易被看成系统图标。
    """
    (x1, y1), (x2, y2) = start, end
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length == 0:
        return
    # 单位法向量，用来把线段「加粗」成四边形
    nx, ny = -dy / length, dx / length
    half = width / 2
    draw.polygon(
        [
            (x1 + nx * half, y1 + ny * half),
            (x2 + nx * half, y2 + ny * half),
            (x2 - nx * half, y2 - ny * half),
            (x1 - nx * half, y1 - ny * half),
        ],
        fill=color,
    )
    for cx, cy in (start, end):
        draw.ellipse([cx - half, cy - half, cx + half, cy + half], fill=color)


def draw_mark(
    size: int,
    *,
    box_ratio: float,
    stroke_ratio: float,
    thin_stroke_ratio: float,
    background,
    color,
) -> Image.Image:
    """在 size×size 画布上居中画一个粗细对比的 X。

    ``box_ratio`` 是**可见图形**占画布的比例（含圆头的外沿）；
    两根对角线分别用 ``stroke_ratio``（粗）与 ``thin_stroke_ratio``（细）。
    端点要从可见边界再往里缩「最粗那根的一半」：圆头是以端点为中心向外扩的，
    不缩的话 X 会顶到画布边上。
    """
    canvas = Image.new("RGB", (size, size), background)
    draw = ImageDraw.Draw(canvas)
    span = size * box_ratio
    thin = size * thin_stroke_ratio
    thick = size * stroke_ratio
    inset = max(thick, thin) / 2
    low = (size - span) / 2 + inset
    high = size - low
    # 粗的那根走「左上 → 右下」，细的走「右上 → 左下」
    thick_line(draw, (low, low), (high, high), thick, color)
    thick_line(draw, (high, low), (low, high), thin, color)
    return canvas


def render(
    size: int,
    *,
    box_ratio: float,
    stroke_ratio: float,
    thin_stroke_ratio: float,
    background=INK,
    color=PAPER,
) -> Image.Image:
    """超采样后降采样，得到边缘干净的成品。"""
    big = draw_mark(
        size * SUPERSAMPLE,
        box_ratio=box_ratio,
        stroke_ratio=stroke_ratio,
        thin_stroke_ratio=thin_stroke_ratio,
        background=background,
        color=color,
    )
    return big.resize((size, size), Image.LANCZOS)


def render_alpha(
    size: int,
    *,
    box_ratio: float,
    stroke_ratio: float,
    thin_stroke_ratio: float,
    color=PAPER,
) -> Image.Image:
    """透明底前景（Android 自适应图标要前沿透明）：

    先把 X 画在近黑底上，再把黑底抠成透明，只保留 mark 的像素。
    """
    big = draw_mark(
        size * SUPERSAMPLE,
        box_ratio=box_ratio,
        stroke_ratio=stroke_ratio,
        thin_stroke_ratio=thin_stroke_ratio,
        background=INK,
        color=color,
    )
    mask = big.convert("L").point(lambda value: 255 if value > 40 else 0)
    foreground = Image.new("RGBA", big.size, (0, 0, 0, 0))
    foreground.paste(big.convert("RGBA"), (0, 0), mask)
    return foreground.resize((size, size), Image.LANCZOS)


def main() -> None:
    parser = argparse.ArgumentParser(description="生成 XaTodo 的 X 字标图标")
    parser.add_argument("--out", default="app/assets", help="输出目录（默认 app/assets）")
    parser.add_argument("--size", type=int, default=1024, help="图标边长（默认 1024）")
    parser.add_argument(
        "--box", type=float, default=0.60,
        help="可见图形占画布的比例（默认 0.60；自适应图标另用 0.44，见下）",
    )
    parser.add_argument("--stroke", type=float, default=0.108, help="粗笔画的占比（默认 0.108）")
    parser.add_argument(
        "--thin-stroke", type=float, default=0.062,
        help="细笔画的占比（默认 0.062；小于 0.055 在 32px 下会糊成一根粗线）",
    )
    args = parser.parse_args()

    out = Path(args.out)
    (out / "store").mkdir(parents=True, exist_ok=True)

    # 1) 应用图标：近黑底 + 白色 X。**必须是 RGB**——iOS 的应用图标不允许带 alpha 通道
    icon = render(
        args.size,
        box_ratio=args.box,
        stroke_ratio=args.stroke,
        thin_stroke_ratio=args.thin_stroke,
    )
    icon.save(out / "icon.png")

    # 2) Android 自适应图标前景：透明底，且缩到**安全圆**里。
    #    安全圆半径是画布的 1/3，X 的四个尖端到中心的距离必须小于它，
    #    否则圆形遮罩会把四个角切掉（0.44 是留了余量的取值，别再往上调）。
    adaptive = render_alpha(
        args.size,
        box_ratio=0.44,
        stroke_ratio=args.stroke * 0.9,
        thin_stroke_ratio=args.thin_stroke * 0.9,
    )
    adaptive.save(out / "adaptive-icon.png")

    # 3) 启动图：白底黑 X，与 app.json 的 splash.backgroundColor 一致
    splash = render(
        args.size,
        box_ratio=0.32,
        stroke_ratio=args.stroke * 0.82,
        thin_stroke_ratio=args.thin_stroke * 0.82,
        background=PAPER,
        color=INK,
    )
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
