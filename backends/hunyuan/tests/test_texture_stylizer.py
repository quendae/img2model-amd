from __future__ import annotations

import unittest

from PIL import Image

from backends.hunyuan.texture_stylizer import apply_texture_style_to_mesh, stylize_texture_image


class _Material:
    def __init__(self, image: Image.Image) -> None:
        self.image = image


class _Visual:
    def __init__(self, image: Image.Image) -> None:
        self.material = _Material(image)


class _Mesh:
    def __init__(self, image: Image.Image) -> None:
        self.visual = _Visual(image)


def _fixture_image() -> Image.Image:
    image = Image.new("RGB", (32, 32))
    pixels = image.load()
    for y in range(32):
        for x in range(32):
            pixels[x, y] = ((x * 8) % 256, (y * 8) % 256, ((x + y) * 4) % 256)
    return image


class TextureStylizerTests(unittest.TestCase):
    def test_match_source_is_pixel_identical(self) -> None:
        source = _fixture_image()
        result = stylize_texture_image(source, preset="match-source", strength=1.0)
        self.assertEqual(list(source.getdata()), list(result.convert("RGB").getdata()))

    def test_non_source_presets_visibly_change_the_atlas(self) -> None:
        source = _fixture_image()
        original = list(source.getdata())
        for preset in ("realistic", "stylized", "hand-painted", "cartoon", "pixel-art"):
            with self.subTest(preset=preset):
                result = stylize_texture_image(source, preset=preset, strength=1.0)
                self.assertNotEqual(original, list(result.convert("RGB").getdata()))

    def test_zero_strength_keeps_original_even_for_cartoon(self) -> None:
        source = _fixture_image()
        result = stylize_texture_image(source, preset="cartoon", strength=0.0)
        self.assertEqual(list(source.getdata()), list(result.convert("RGB").getdata()))

    def test_reference_palette_guides_output_colors(self) -> None:
        source = _fixture_image()
        reference = Image.new("RGB", (16, 16), (220, 40, 40))
        result = stylize_texture_image(
            source,
            preset="stylized",
            strength=1.0,
            reference_image=reference,
            preserve_source_colors=False,
        )
        r, g, b = result.convert("RGB").resize((1, 1)).getpixel((0, 0))
        self.assertGreater(r, g)
        self.assertGreater(r, b)

    def test_mesh_material_image_is_replaced_without_touching_mesh_identity(self) -> None:
        mesh = _Mesh(_fixture_image())
        original_id = id(mesh)
        changed = apply_texture_style_to_mesh(mesh, preset="pixel-art", strength=1.0)
        self.assertIs(changed, mesh)
        self.assertEqual(id(mesh), original_id)
        self.assertEqual(mesh.visual.material.image.size, (32, 32))


if __name__ == "__main__":
    unittest.main()
