"""Base Gallery surfaces for the local Tk Bridge, using native ttk controls."""
from tkinter import font as tkfont, ttk

from PIL import Image, ImageDraw, ImageTk


def apply_base_theme(root):
    """Apply the light Bridge theme and keep its nine-slice images alive."""
    colors = {
        "surface": "#FFFFFF",
        "ink": "#000000",
        "muted": "#5E5E5E",
        "field": "#E8E8E8",
        "border": "#E2E2E2",
        "focus": "#276EF1",
        "disabled_bg": "#F3F3F3",
        "disabled_fg": "#A6A6A6",
        "pressed": "#333333",
    }
    fonts = {
        "title": ("Segoe UI", 18, "bold"),
        "heading": ("Microsoft YaHei UI", 11, "bold"),
        "body": ("Microsoft YaHei UI", 10),
        "caption": ("Microsoft YaHei UI", 9),
        "mono": ("Consolas", 9),
    }
    style = ttk.Style(root)
    style.theme_use("clam")
    root.configure(background=colors["surface"])
    images = []
    root._bridge_theme_images = images

    def rounded(fill, radius, stroke=None, width=0):
        # A small anti-aliased tile is stretched only between its four corners.
        size = max(32, radius * 2 + 2)
        scale = 3
        image = Image.new("RGBA", (size * scale, size * scale))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle(
            (0, 0, size * scale - 1, size * scale - 1),
            radius=radius * scale,
            fill=fill,
            outline=stroke,
            width=width * scale,
        )
        image = image.resize((size, size), Image.Resampling.LANCZOS)
        photo = ImageTk.PhotoImage(image, master=root)
        images.append(photo)
        return photo

    def surface(name, fill, radius, stroke=None, width=0):
        element = name + ".surface"
        style.element_create(
            element, "image", rounded(fill, radius, stroke, width),
            border=radius, padding=0, sticky="nsew",
        )
        style.layout(name, [(element, {"sticky": "nsew"})])
        style.configure(name, background=colors["surface"])

    style.configure("Bridge.TFrame", background=colors["surface"])
    for name, font, color in (
        ("Title", fonts["title"], colors["ink"]),
        ("Heading", fonts["heading"], colors["ink"]),
        ("Body", fonts["body"], colors["ink"]),
        ("Muted", fonts["body"], colors["muted"]),
        ("Caption", fonts["caption"], colors["muted"]),
    ):
        style.configure(
            "Bridge." + name + ".TLabel",
            background=colors["surface"], foreground=color, font=font,
        )

    surface("Bridge.Card.TFrame", colors["surface"], 12, colors["border"], 2)
    surface("Bridge.Field.TFrame", colors["field"], 8)
    surface("Bridge.FocusField.TFrame", colors["field"], 8, colors["focus"], 3)

    text_height = tkfont.Font(root=root, font=fonts["body"]).metrics("linespace")
    for name, fill, foreground, height, horizontal in (
        ("Primary", colors["ink"], colors["surface"], 48, 16),
        ("Secondary", colors["field"], colors["ink"], 48, 16),
        ("Small", colors["field"], colors["ink"], 36, 12),
        ("Ghost", colors["surface"], colors["ink"], 36, 12),
    ):
        element = "Bridge." + name + ".border"
        # Base's secondary pressed state overlays 8% black on its fill.
        pressed = colors["pressed"] if name == "Primary" else "#" + "".join(
            f"{round(int(fill[i:i + 2], 16) * .92):02X}" for i in (1, 3, 5)
        )
        vertical = max(0, height - text_height)
        padding = (horizontal, vertical // 2, horizontal, vertical - vertical // 2)
        style.element_create(
            element, "image", rounded(fill, 8),
            ("disabled", rounded(colors["disabled_bg"], 8)),
            ("pressed", rounded(pressed, 8)),
            ("focus", rounded(fill, 8, colors["focus"], 3)),
            border=8, padding=0, sticky="nsew",
        )
        name = "Bridge." + name + ".TButton"
        style.layout(name, [(element, {
            "sticky": "nsew", "children": [("Button.padding", {
                "sticky": "nsew", "children": [("Button.label", {
                    "sticky": "nsew",
                })],
            })],
        })])
        style.configure(
            name, foreground=foreground, font=fonts["body"], padding=padding,
            anchor="center", borderwidth=0, relief="flat",
        )
        style.map(name, foreground=[("disabled", colors["disabled_fg"])])

    style.configure(
        "Bridge.TEntry", font=fonts["body"], foreground=colors["ink"],
        fieldbackground=colors["field"], background=colors["field"],
        bordercolor=colors["field"], lightcolor=colors["field"],
        darkcolor=colors["field"], borderwidth=0, relief="flat", padding=(0, 2),
        insertcolor=colors["ink"],
    )
    style.map(
        "Bridge.TEntry",
        fieldbackground=[("disabled", colors["disabled_bg"]), ("readonly", colors["field"])],
        foreground=[("disabled", colors["disabled_fg"])],
        bordercolor=[("focus", colors["field"])],
        lightcolor=[("focus", colors["field"])],
        darkcolor=[("focus", colors["field"])],
    )
    style.configure(
        "Bridge.Horizontal.TProgressbar", background=colors["ink"],
        troughcolor=colors["field"], bordercolor=colors["field"],
        lightcolor=colors["ink"], darkcolor=colors["ink"],
        borderwidth=0, thickness=6,
    )
    return {"colors": colors, "fonts": fonts}
