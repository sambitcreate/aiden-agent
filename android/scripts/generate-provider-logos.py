#!/usr/bin/env python3
"""Generate Android VectorDrawables for Aiden's provider logos.

The canonical marks live in ``renderer/assets/provider-logos/*.svg`` and are
shared with the desktop ``ProviderIcon`` and the iOS asset catalog. This script
converts each one into ``android/app/src/main/res/drawable/ic_provider_<slug>.xml``
so the three clients draw the same identity map.

Only the SVG subset those files use is supported: path, rect, circle, ellipse,
polygon, polyline, and line; nested ``<svg>`` and ``<g>`` groups; translate,
scale, and rotate transforms; ``<clipPath>`` references; and class rules from a
``<style>`` block. Anything else fails loudly rather than drawing a wrong mark.

Mono marks (every slug outside ``MULTICOLOR_SLUGS``) are written with one opaque
black fill so Compose can tint them with the theme's content color, matching the
desktop CSS mask and the iOS template rendering. Multicolor marks keep their
brand colors. Elements that sit entirely outside the viewBox (the wordmark half
of the Fireworks, Together, and Grok sources, which crop to the logomark) are
dropped instead of being carried as invisible path data.

Usage (from the repository root or anywhere else):

    python3 android/scripts/generate-provider-logos.py          # write drawables
    python3 android/scripts/generate-provider-logos.py --check  # fail on drift

Python 3.9+ standard library only.
"""

from __future__ import annotations

import argparse
import math
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = REPO_ROOT / "renderer" / "assets" / "provider-logos"
OUTPUT_DIR = REPO_ROOT / "android" / "app" / "src" / "main" / "res" / "drawable"

# Mirrors MULTICOLOR_PROVIDER_ICON_SLUGS in renderer/components/provider-icon.tsx
# and AidenProviderIconResolver.multicolorSlugs on iOS and Android.
MULTICOLOR_SLUGS = {
    "fireworks",
    "groq",
    "opencode",
    "opencode-go",
    "together",
    "zai",
    "zai-coding-cn",
}

# Longest side of the drawable's intrinsic size. Call sites always size the icon
# explicitly, so this only matters for previews and density-independent tooling.
INTRINSIC_DP = 24.0

MONO_COLOR = "#FF000000"

NAMED_COLORS = {
    "black": "#000000",
    "white": "#FFFFFF",
    "currentcolor": "#000000",
}

INHERITED = {
    "fill",
    "fill-rule",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
}
PRESENTATION = INHERITED | {"opacity", "clip-path", "clip-rule"}

IGNORED_TAGS = {"title", "desc", "metadata", "style", "defs", "clipPath"}


class ConversionError(Exception):
    pass


# --------------------------------------------------------------------------- #
# Path data
# --------------------------------------------------------------------------- #

ARG_COUNTS = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}
NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
SEPARATORS = " \t\r\n,"


def parse_path(d: str) -> list[tuple[str, list[str]]]:
    """Tokenize SVG path data, including packed arc flags such as ``a1 1 0 000 2``."""
    segments: list[tuple[str, list[str]]] = []
    pos = 0
    length = len(d)

    def skip() -> None:
        nonlocal pos
        while pos < length and d[pos] in SEPARATORS:
            pos += 1

    def read_number() -> str:
        nonlocal pos
        skip()
        match = NUMBER.match(d, pos)
        if not match:
            raise ConversionError(f"expected a number at {pos} in path {d[:60]!r}")
        pos = match.end()
        return match.group()

    def read_flag() -> str:
        nonlocal pos
        skip()
        if pos >= length or d[pos] not in "01":
            raise ConversionError(f"expected an arc flag at {pos} in path {d[:60]!r}")
        pos += 1
        return d[pos - 1]

    skip()
    while pos < length:
        command = d[pos]
        upper = command.upper()
        if upper not in ARG_COUNTS:
            raise ConversionError(f"unsupported path command {command!r}")
        pos += 1
        count = ARG_COUNTS[upper]
        if count == 0:
            segments.append((command, []))
            skip()
            continue
        first = True
        while True:
            skip()
            if pos >= length or d[pos].isalpha():
                break
            args = [
                read_flag() if upper == "A" and index in (3, 4) else read_number()
                for index in range(count)
            ]
            if first or upper != "M":
                segments.append((command, args))
            else:
                # Extra coordinate pairs after a moveto are implicit linetos.
                segments.append(("L" if command == "M" else "l", args))
            first = False
        if first:
            raise ConversionError(f"path command {command!r} has no arguments")
    return segments


def format_number(token: str) -> str:
    value = float(token)
    if value == 0:
        return "0"
    text = token.lstrip("+")
    if "e" in text or "E" in text:
        return repr(value)
    negative = text.startswith("-")
    digits = text[1:] if negative else text
    if digits.startswith("."):
        digits = "0" + digits
    if digits.endswith("."):
        digits = digits[:-1]
    if "." in digits:
        digits = digits.rstrip("0").rstrip(".")
    return ("-" if negative else "") + digits


def serialize_path(segments: list[tuple[str, list[str]]]) -> str:
    return "".join(command + " ".join(format_number(a) for a in args) for command, args in segments)


def path_points(segments: list[tuple[str, list[str]]]) -> list[tuple[float, float]]:
    """Endpoints and control points, a superset of the path's extent.

    Arcs contribute the bounding box of their whole ellipse so a circle is never
    mistaken for a line.
    """
    points: list[tuple[float, float]] = []
    x = y = start_x = start_y = 0.0
    last_control: tuple[float, float] | None = None
    last_upper = ""
    for command, raw in segments:
        args = [float(a) for a in raw]
        upper = command.upper()
        relative = command.islower()
        ox, oy = (x, y) if relative else (0.0, 0.0)
        control: tuple[float, float] | None = None
        if upper == "Z":
            x, y = start_x, start_y
        elif upper == "M":
            x, y = ox + args[0], oy + args[1]
            start_x, start_y = x, y
            points.append((x, y))
        elif upper == "L" or upper == "T":
            if upper == "T":
                control = reflect(last_control, x, y) if last_upper in ("Q", "T") else (x, y)
                points.append(control)
            x, y = ox + args[0], oy + args[1]
            points.append((x, y))
        elif upper == "H":
            x = (x if relative else 0.0) + args[0]
            points.append((x, y))
        elif upper == "V":
            y = (y if relative else 0.0) + args[0]
            points.append((x, y))
        elif upper == "C":
            points.append((ox + args[0], oy + args[1]))
            control = (ox + args[2], oy + args[3])
            points.append(control)
            x, y = ox + args[4], oy + args[5]
            points.append((x, y))
        elif upper == "S":
            points.append(reflect(last_control, x, y) if last_upper in ("C", "S") else (x, y))
            control = (ox + args[0], oy + args[1])
            points.append(control)
            x, y = ox + args[2], oy + args[3]
            points.append((x, y))
        elif upper == "Q":
            control = (ox + args[0], oy + args[1])
            points.append(control)
            x, y = ox + args[2], oy + args[3]
            points.append((x, y))
        elif upper == "A":
            end_x, end_y = ox + args[5], oy + args[6]
            points.extend(arc_ellipse_box(x, y, args, end_x, end_y))
            x, y = end_x, end_y
        last_control = control
        last_upper = upper
    return points


def arc_ellipse_box(x0: float, y0: float, args: list[float], x1: float, y1: float) -> list[tuple[float, float]]:
    """Corners of the box around the ellipse an SVG arc segment lies on (SVG 1.1 F.6.5)."""
    rx, ry, angle = abs(args[0]), abs(args[1]), math.radians(args[2])
    large, sweep = args[3] != 0, args[4] != 0
    if rx == 0 or ry == 0 or (x0 == x1 and y0 == y1):
        return [(x0, y0), (x1, y1)]
    cos, sin = math.cos(angle), math.sin(angle)
    dx, dy = (x0 - x1) / 2, (y0 - y1) / 2
    px, py = cos * dx + sin * dy, -sin * dx + cos * dy
    scale = (px * px) / (rx * rx) + (py * py) / (ry * ry)
    if scale > 1:
        rx, ry = rx * math.sqrt(scale), ry * math.sqrt(scale)
    numerator = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px
    denominator = rx * rx * py * py + ry * ry * px * px
    factor = math.sqrt(max(0.0, numerator / denominator)) if denominator else 0.0
    if large == sweep:
        factor = -factor
    cxp, cyp = factor * rx * py / ry, -factor * ry * px / rx
    cx = cos * cxp - sin * cyp + (x0 + x1) / 2
    cy = sin * cxp + cos * cyp + (y0 + y1) / 2
    half_w = math.hypot(rx * cos, ry * sin)
    half_h = math.hypot(rx * sin, ry * cos)
    return [(x0, y0), (x1, y1), (cx - half_w, cy - half_h), (cx + half_w, cy + half_h)]


def reflect(control: tuple[float, float] | None, x: float, y: float) -> tuple[float, float]:
    if control is None:
        return (x, y)
    return (2 * x - control[0], 2 * y - control[1])


# --------------------------------------------------------------------------- #
# Shapes
# --------------------------------------------------------------------------- #


def number_attr(element: ET.Element, name: str, default: float = 0.0) -> float:
    value = element.get(name)
    if value is None:
        return default
    match = NUMBER.match(value.strip())
    if not match or match.group() != value.strip().removesuffix("px"):
        raise ConversionError(f"unsupported length {name}={value!r}")
    return float(match.group())


def fmt(value: float) -> str:
    return format_number(repr(round(value, 4)))


def shape_path(tag: str, element: ET.Element) -> str | None:
    if tag == "path":
        return element.get("d") or None
    if tag == "rect":
        x, y = number_attr(element, "x"), number_attr(element, "y")
        w, h = number_attr(element, "width"), number_attr(element, "height")
        if w <= 0 or h <= 0:
            return None
        rx = element.get("rx")
        ry = element.get("ry")
        rx_value = number_attr(element, "rx") if rx is not None else None
        ry_value = number_attr(element, "ry") if ry is not None else None
        rx_value = rx_value if rx_value is not None else (ry_value or 0.0)
        ry_value = ry_value if ry_value is not None else rx_value
        rx_value, ry_value = min(rx_value, w / 2), min(ry_value, h / 2)
        if rx_value <= 0 or ry_value <= 0:
            return f"M{fmt(x)} {fmt(y)}h{fmt(w)}v{fmt(h)}h{fmt(-w)}z"
        a = f"a{fmt(rx_value)} {fmt(ry_value)} 0 0 1 "
        return (
            f"M{fmt(x + rx_value)} {fmt(y)}h{fmt(w - 2 * rx_value)}"
            f"{a}{fmt(rx_value)} {fmt(ry_value)}v{fmt(h - 2 * ry_value)}"
            f"{a}{fmt(-rx_value)} {fmt(ry_value)}h{fmt(-(w - 2 * rx_value))}"
            f"{a}{fmt(-rx_value)} {fmt(-ry_value)}v{fmt(-(h - 2 * ry_value))}"
            f"{a}{fmt(rx_value)} {fmt(-ry_value)}z"
        )
    if tag in ("circle", "ellipse"):
        cx, cy = number_attr(element, "cx"), number_attr(element, "cy")
        if tag == "circle":
            rx = ry = number_attr(element, "r")
        else:
            rx, ry = number_attr(element, "rx"), number_attr(element, "ry")
        if rx <= 0 or ry <= 0:
            return None
        arc = f"a{fmt(rx)} {fmt(ry)} 0 1 0 "
        return f"M{fmt(cx - rx)} {fmt(cy)}{arc}{fmt(2 * rx)} 0{arc}{fmt(-2 * rx)} 0z"
    if tag in ("polygon", "polyline"):
        numbers = NUMBER.findall(element.get("points", ""))
        if len(numbers) < 4 or len(numbers) % 2:
            raise ConversionError(f"malformed {tag} points")
        pairs = [f"{format_number(numbers[i])} {format_number(numbers[i + 1])}" for i in range(0, len(numbers), 2)]
        return "M" + "L".join(pairs) + ("z" if tag == "polygon" else "")
    if tag == "line":
        return (
            f"M{fmt(number_attr(element, 'x1'))} {fmt(number_attr(element, 'y1'))}"
            f"L{fmt(number_attr(element, 'x2'))} {fmt(number_attr(element, 'y2'))}"
        )
    return None


# --------------------------------------------------------------------------- #
# Styles, colors, transforms
# --------------------------------------------------------------------------- #


def parse_css(text: str) -> dict[str, dict[str, str]]:
    """Class rules from a <style> block; @media and other at-rules are skipped."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    rules: dict[str, dict[str, str]] = {}
    pos = 0
    while True:
        open_brace = text.find("{", pos)
        if open_brace < 0:
            break
        selector = text[pos:open_brace].strip()
        depth, cursor = 1, open_brace + 1
        while depth and cursor < len(text):
            depth += {"{": 1, "}": -1}.get(text[cursor], 0)
            cursor += 1
        body = text[open_brace + 1 : cursor - 1]
        pos = cursor
        if selector.startswith("@"):
            continue
        declarations = parse_declarations(body)
        for single in selector.split(","):
            single = single.strip()
            if not re.fullmatch(r"\.[\w-]+", single):
                raise ConversionError(f"unsupported CSS selector {single!r}")
            rules.setdefault(single[1:], {}).update(declarations)
    return rules


def parse_declarations(body: str) -> dict[str, str]:
    result = {}
    for declaration in body.split(";"):
        if ":" in declaration:
            name, value = declaration.split(":", 1)
            result[name.strip()] = value.strip()
    return result


def parse_color(value: str) -> str | None:
    """#AARRGGBB for a paint value, or None for ``none``."""
    value = value.strip()
    lowered = value.lower()
    if lowered in ("none", "transparent"):
        return None
    if lowered in NAMED_COLORS:
        value = NAMED_COLORS[lowered]
    if lowered.startswith("url("):
        raise ConversionError(f"paint servers are not supported ({value})")
    match = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", value)
    if not match:
        raise ConversionError(f"unsupported color {value!r}")
    digits = match.group(1)
    if len(digits) == 3:
        digits = "".join(c * 2 for c in digits)
    return "#FF" + digits.upper()


def parse_opacity(value: str | None) -> float:
    return 1.0 if value is None else max(0.0, min(1.0, float(value)))


Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def multiply(a: Matrix, b: Matrix) -> Matrix:
    return (
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    )


def apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


@dataclass
class Transform:
    """One SVG transform, expressed as VectorDrawable group attributes."""

    attrs: dict[str, float]
    matrix: Matrix


def parse_transform(value: str | None) -> list[Transform]:
    if not value:
        return []
    transforms = []
    for name, raw in re.findall(r"(\w+)\s*\(([^)]*)\)", value):
        args = [float(n) for n in NUMBER.findall(raw)]
        if name == "translate":
            tx, ty = args[0], args[1] if len(args) > 1 else 0.0
            transforms.append(Transform({"translateX": tx, "translateY": ty}, (1, 0, 0, 1, tx, ty)))
        elif name == "scale":
            sx, sy = args[0], args[1] if len(args) > 1 else args[0]
            transforms.append(Transform({"scaleX": sx, "scaleY": sy}, (sx, 0, 0, sy, 0, 0)))
        elif name == "rotate":
            angle = args[0]
            attrs = {"rotation": angle}
            if len(args) == 3:
                attrs.update({"pivotX": args[1], "pivotY": args[2]})
            rad = math.radians(angle)
            cos, sin = math.cos(rad), math.sin(rad)
            px, py = (args[1], args[2]) if len(args) == 3 else (0.0, 0.0)
            matrix = multiply((1, 0, 0, 1, px, py), multiply((cos, sin, -sin, cos, 0, 0), (1, 0, 0, 1, -px, -py)))
            transforms.append(Transform(attrs, matrix))
        else:
            raise ConversionError(f"unsupported transform {name}()")
    return transforms


# --------------------------------------------------------------------------- #
# Intermediate drawing model
# --------------------------------------------------------------------------- #


@dataclass
class VPath:
    data: str
    fill: str | None
    fill_alpha: float
    fill_type: str
    stroke: str | None = None
    stroke_width: float = 1.0
    stroke_alpha: float = 1.0
    stroke_linecap: str | None = None
    stroke_linejoin: str | None = None
    stroke_miter: float | None = None
    # Extent of each shape folded into this path, used to keep merges disjoint.
    bounds: list[tuple[float, float, float, float]] = field(default_factory=list)

    def merge_key(self) -> tuple | None:
        """Consecutive solid nonzero fills with the same paint can share one path."""
        if self.stroke or self.fill_type != "nonZero" or not self.data.startswith("M"):
            return None
        return (self.fill, self.fill_alpha)

    def can_absorb(self, other: "VPath") -> bool:
        # Nonzero winding only equals a union when the shapes do not overlap: two
        # overlapping subpaths wound in opposite directions would cancel to a hole.
        key = self.merge_key()
        if key is None or key != other.merge_key():
            return False
        return not any(overlaps(a, b) for a in self.bounds for b in other.bounds)


@dataclass
class VGroup:
    transform: dict[str, float] = field(default_factory=dict)
    clip: str | None = None
    children: list = field(default_factory=list)


class Converter:
    def __init__(self, slug: str, root: ET.Element, mono: bool):
        self.slug = slug
        self.mono = mono
        self.root = root
        self.css: dict[str, dict[str, str]] = {}
        self.clip_paths: dict[str, ET.Element] = {}
        self.dropped = 0
        self.colors: set[str] = set()
        for element in root.iter():
            tag = local(element.tag)
            if tag == "style":
                self.css.update(parse_css(element.text or ""))
            elif tag == "clipPath" and element.get("id"):
                self.clip_paths[element.get("id")] = element
        self.view_box = self.root_view_box()

    def root_view_box(self) -> tuple[float, float, float, float]:
        for element in self.root.iter():
            if local(element.tag) == "svg" and element.get("viewBox"):
                values = [float(n) for n in NUMBER.findall(element.get("viewBox"))]
                if len(values) == 4 and values[2] > 0 and values[3] > 0:
                    return tuple(values)  # type: ignore[return-value]
        width, height = number_attr(self.root, "width"), number_attr(self.root, "height")
        if width <= 0 or height <= 0:
            raise ConversionError("no viewBox or intrinsic size")
        return (0.0, 0.0, width, height)

    def styles(self, element: ET.Element, inherited: dict[str, str]) -> dict[str, str]:
        own: dict[str, str] = {}
        for name in PRESENTATION:
            if element.get(name) is not None:
                own[name] = element.get(name)
        for class_name in (element.get("class") or "").split():
            own.update({k: v for k, v in self.css.get(class_name, {}).items() if k in PRESENTATION})
        own.update({k: v for k, v in parse_declarations(element.get("style") or "").items() if k in PRESENTATION})
        unknown = set(parse_declarations(element.get("style") or "")) - PRESENTATION - {"enable-background"}
        if unknown:
            raise ConversionError(f"unsupported style properties {sorted(unknown)}")
        merged = {k: v for k, v in inherited.items() if k in INHERITED}
        merged.update(own)
        return merged

    def convert(self) -> VGroup:
        top = VGroup()
        min_x, min_y = self.view_box[0], self.view_box[1]
        if min_x or min_y:
            top.transform = {"translateX": -min_x, "translateY": -min_y}
        if self.root.get("transform"):
            raise ConversionError("a transform on the root <svg> is not supported")
        root_style = self.styles(self.root, {"fill": "#000000"})
        opacity = parse_opacity(root_style.get("opacity"))
        top.children = self.children_of(self.root, root_style, IDENTITY, opacity)
        return top

    def children_of(self, element: ET.Element, inherited: dict[str, str], matrix: Matrix, opacity: float) -> list:
        nodes: list = []
        for child in element:
            nodes.extend(self.node(child, inherited, matrix, opacity))
        return nodes

    def node(self, element: ET.Element, inherited: dict[str, str], matrix: Matrix, opacity: float) -> list:
        tag = local(element.tag)
        if tag in IGNORED_TAGS:
            return []
        if element.get("display") == "none" or element.get("visibility") == "hidden":
            return []
        style = self.styles(element, inherited)
        transforms = parse_transform(element.get("transform"))
        if len(transforms) > 1:
            raise ConversionError("multiple transforms on one element are not supported")
        for transform in transforms:
            matrix = multiply(matrix, transform.matrix)
        opacity *= parse_opacity(style.get("opacity"))
        clip = self.clip_data(style.get("clip-path"))

        if tag in ("g", "svg", "a"):
            if tag == "svg" and element is not self.root:
                self.check_nested_svg(element)
            content = self.children_of(element, style, matrix, opacity)
        else:
            data = shape_path(tag, element)
            if data is None:
                if tag not in ("path", "rect", "circle", "ellipse", "polygon", "polyline", "line"):
                    raise ConversionError(f"unsupported element <{tag}>")
                return []
            segments = parse_path(data)
            if not segments:
                return []
            points = path_points(segments)
            if not self.intersects_view_box(points, matrix):
                self.dropped += 1
                return []
            vpath = self.vector_path(serialize_path(segments), style, opacity)
            if vpath is None:
                return []
            xs, ys = [p[0] for p in points], [p[1] for p in points]
            vpath.bounds = [(min(xs), min(ys), max(xs), max(ys))]
            content = [vpath]

        if not transforms and clip is None:
            return content
        if not content:
            return []
        group = VGroup(clip=clip, children=content)
        if transforms:
            group.transform = dict(transforms[0].attrs)
        return [group]

    def check_nested_svg(self, element: ET.Element) -> None:
        if number_attr(element, "x") or number_attr(element, "y"):
            raise ConversionError("offset nested <svg> is not supported")
        view_box = element.get("viewBox")
        if view_box:
            values = tuple(float(n) for n in NUMBER.findall(view_box))
            if values != self.view_box:
                raise ConversionError("nested <svg> with a different viewBox is not supported")

    def clip_data(self, reference: str | None) -> str | None:
        if not reference or reference == "none":
            return None
        match = re.fullmatch(r"url\(#([^)]+)\)", reference.strip())
        if not match or match.group(1) not in self.clip_paths:
            raise ConversionError(f"unresolved clip-path {reference!r}")
        clip_element = self.clip_paths[match.group(1)]
        if clip_element.get("clipPathUnits", "userSpaceOnUse") != "userSpaceOnUse":
            raise ConversionError("clipPathUnits other than userSpaceOnUse are not supported")
        parts = []
        for child in clip_element:
            if child.get("transform"):
                raise ConversionError("transformed clip-path children are not supported")
            data = shape_path(local(child.tag), child)
            if data:
                parts.append(serialize_path(parse_path(data)))
        if not parts:
            raise ConversionError(f"empty clip-path {reference!r}")
        return "".join(parts)

    def intersects_view_box(self, points: list[tuple[float, float]], matrix: Matrix) -> bool:
        mapped = [apply(matrix, x, y) for x, y in points]
        xs = [p[0] for p in mapped]
        ys = [p[1] for p in mapped]
        vx, vy, vw, vh = self.view_box
        return max(xs) > vx and min(xs) < vx + vw and max(ys) > vy and min(ys) < vy + vh

    def vector_path(self, data: str, style: dict[str, str], opacity: float) -> VPath | None:
        fill = parse_color(style.get("fill", "#000000"))
        stroke = parse_color(style["stroke"]) if "stroke" in style else None
        stroke_width = float(style.get("stroke-width", "1").removesuffix("px"))
        if stroke is not None and stroke_width <= 0:
            stroke = None
        if fill is None and stroke is None:
            return None
        fill_alpha = opacity * parse_opacity(style.get("fill-opacity"))
        stroke_alpha = opacity * parse_opacity(style.get("stroke-opacity"))
        for color in (fill, stroke):
            if color is not None:
                self.colors.add(color)
        if self.mono:
            # A tinted icon paints every covered pixel in one color, so an inner
            # detail drawn in a second color would vanish. Refuse instead.
            fill = MONO_COLOR if fill is not None else None
            stroke = MONO_COLOR if stroke is not None else None
        path = VPath(
            data=data,
            fill=fill,
            fill_alpha=fill_alpha,
            fill_type="evenOdd" if style.get("fill-rule") == "evenodd" else "nonZero",
            stroke=stroke,
            stroke_width=stroke_width,
            stroke_alpha=stroke_alpha,
        )
        if stroke is not None:
            path.stroke_linecap = style.get("stroke-linecap")
            path.stroke_linejoin = style.get("stroke-linejoin")
            if "stroke-miterlimit" in style:
                path.stroke_miter = float(style["stroke-miterlimit"])
        return path


def overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def merge_paths(nodes: list) -> list:
    merged: list = []
    for node in nodes:
        previous = merged[-1] if merged else None
        if isinstance(node, VGroup):
            if (
                isinstance(previous, VGroup)
                and previous.clip is None
                and node.clip is None
                and previous.transform == node.transform
            ):
                # Sibling shapes that share one transform (xAI's polygons) share a group.
                previous.children = merge_paths(previous.children + node.children)
            else:
                node.children = merge_paths(node.children)
                merged.append(node)
            continue
        if isinstance(previous, VPath) and previous.can_absorb(node):
            previous.data += node.data
            previous.bounds += node.bounds
        else:
            merged.append(node)
    return merged


def count_paths(nodes: list) -> int:
    return sum(count_paths(n.children) if isinstance(n, VGroup) else 1 for n in nodes)


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #


def alpha_attr(name: str, value: float) -> str | None:
    return None if value >= 1.0 else f'android:{name}="{fmt(value)}"'


def render_path(path: VPath, indent: str) -> list[str]:
    attrs = []
    if path.fill is not None:
        attrs.append(f'android:fillColor="{path.fill}"')
        attrs.append(alpha_attr("fillAlpha", path.fill_alpha))
        if path.fill_type == "evenOdd":
            attrs.append('android:fillType="evenOdd"')
    if path.stroke is not None:
        attrs.append(f'android:strokeColor="{path.stroke}"')
        attrs.append(f'android:strokeWidth="{fmt(path.stroke_width)}"')
        attrs.append(alpha_attr("strokeAlpha", path.stroke_alpha))
        if path.stroke_linecap:
            attrs.append(f'android:strokeLineCap="{path.stroke_linecap}"')
        if path.stroke_linejoin:
            attrs.append(f'android:strokeLineJoin="{path.stroke_linejoin}"')
        if path.stroke_miter is not None:
            attrs.append(f'android:strokeMiterLimit="{fmt(path.stroke_miter)}"')
    attrs.append(f'android:pathData="{path.data}"')
    attrs = [a for a in attrs if a]
    lines = [f"{indent}<path"]
    lines += [f"{indent}    {a}" for a in attrs[:-1]]
    lines.append(f"{indent}    {attrs[-1]} />")
    return lines


def render_nodes(nodes: list, indent: str) -> list[str]:
    lines: list[str] = []
    for node in nodes:
        if isinstance(node, VPath):
            lines += render_path(node, indent)
            continue
        attrs = " ".join(f'android:{k}="{fmt(v)}"' for k, v in node.transform.items())
        lines.append(f"{indent}<group{' ' + attrs if attrs else ''}>")
        if node.clip:
            lines.append(f'{indent}    <clip-path android:pathData="{node.clip}" />')
        lines += render_nodes(node.children, indent + "    ")
        lines.append(f"{indent}</group>")
    return lines


def convert(slug: str, source: Path) -> tuple[str, str]:
    mono = slug not in MULTICOLOR_SLUGS
    try:
        root = ET.parse(source).getroot()
        converter = Converter(slug, root, mono)
        top = converter.convert()
    except (ConversionError, ET.ParseError, ValueError) as error:
        raise ConversionError(f"{source.name}: {error}") from error

    top.children = merge_paths(top.children)
    if count_paths(top.children) == 0:
        raise ConversionError(f"{source.name}: nothing left to draw")
    if mono and len(converter.colors) > 1:
        raise ConversionError(
            f"{source.name}: a mono mark uses several colors {sorted(converter.colors)}; "
            "add it to MULTICOLOR_SLUGS (and the desktop/iOS sets) or simplify the source"
        )

    _, _, width, height = converter.view_box
    scale = INTRINSIC_DP / max(width, height)
    body = top.children if not top.transform else [top]
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        f"<!-- Generated by android/scripts/generate-provider-logos.py from",
        f"     renderer/assets/provider-logos/{source.name}. Do not edit by hand. -->",
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
        '    xmlns:tools="http://schemas.android.com/tools"',
        f'    android:width="{fmt(width * scale)}dp"',
        f'    android:height="{fmt(height * scale)}dp"',
        f'    android:viewportWidth="{fmt(width)}"',
        f'    android:viewportHeight="{fmt(height)}"',
        '    tools:ignore="VectorPath">',
        *render_nodes(body, "    "),
        "</vector>",
        "",
    ]
    note = f"{'mono' if mono else 'multicolor'}, {count_paths(top.children)} path(s)"
    if converter.dropped:
        note += f", dropped {converter.dropped} element(s) outside the viewBox"
    return "\n".join(lines), note


def drawable_name(slug: str) -> str:
    return "ic_provider_" + slug.replace("-", "_") + ".xml"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="fail if any drawable is missing or stale")
    options = parser.parse_args()

    sources = sorted(SOURCE_DIR.glob("*.svg"))
    if not sources:
        print(f"No SVGs found in {SOURCE_DIR}", file=sys.stderr)
        return 1
    unknown_multicolor = MULTICOLOR_SLUGS - {s.stem for s in sources}
    if unknown_multicolor:
        print(f"MULTICOLOR_SLUGS has no source for {sorted(unknown_multicolor)}", file=sys.stderr)
        return 1

    expected = {}
    failures = []
    for source in sources:
        try:
            xml, note = convert(source.stem, source)
        except ConversionError as error:
            failures.append(str(error))
            continue
        expected[drawable_name(source.stem)] = xml
        if not options.check:
            print(f"{drawable_name(source.stem)}: {note}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1

    existing = {p.name for p in OUTPUT_DIR.glob("ic_provider_*.xml")}
    stale = sorted(existing - set(expected))
    if options.check:
        drift = [name for name, xml in expected.items() if not (OUTPUT_DIR / name).is_file() or (OUTPUT_DIR / name).read_text() != xml]
        if drift or stale:
            print("Provider drawables are out of date; run android/scripts/generate-provider-logos.py", file=sys.stderr)
            for name in drift + stale:
                print(f"  {name}", file=sys.stderr)
            return 1
        print(f"{len(expected)} provider drawables are up to date.")
        return 0

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, xml in expected.items():
        (OUTPUT_DIR / name).write_text(xml)
    for name in stale:
        (OUTPUT_DIR / name).unlink()
        print(f"removed stale {name}")
    print(f"Wrote {len(expected)} provider drawables to {OUTPUT_DIR.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
