"""Package the user's original Figma PNG into Windows ICO without redrawing it."""

from pathlib import Path

from PIL import Image


def main():
    assets = Path(__file__).resolve().parent.parent / "desktop" / "assets"
    sizes = [(size, size) for size in (16, 20, 24, 32, 48, 64, 128, 256)]
    with Image.open(assets / "mg2fig-dark.png") as image:
        if image.width != image.height or image.width < 256:
            raise ValueError("M2Fig source PNG must be square and at least 256px.")
        image.convert("RGBA").save(assets / "mg2fig.ico", format="ICO", sizes=sizes)
    with Image.open(assets / "mg2fig.ico") as icon:
        if icon.ico.sizes() != set(sizes):
            raise ValueError("M2Fig ICO is missing required sizes.")
    print(f"M2Fig ICO: {len(sizes)} sizes, 16-256px")


if __name__ == "__main__":
    main()
