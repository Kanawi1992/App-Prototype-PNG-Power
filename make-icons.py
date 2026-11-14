# Generates the logo and app icon set from assets/logo-source.png.
# Run: python3 scripts/make-icons.py
from PIL import Image
import os
root = os.path.join(os.path.dirname(__file__), '..', 'assets')
src = Image.open(os.path.join(root, 'logo-source.png')).convert('RGB')

def square(size, fill_ratio=1.0, bg=(0, 0, 0)):
    canvas = Image.new('RGB', (size, size), bg)
    inner = int(size * fill_ratio)
    art = src.resize((inner, inner), Image.LANCZOS)
    off = (size - inner) // 2
    canvas.paste(art, (off, off))
    return canvas

out = {
    'logo-256.png': square(256),
    'icons/icon-192.png': square(192),
    'icons/icon-512.png': square(512),
    # maskable: keep the artwork inside the central 80% safe zone
    'icons/icon-maskable-512.png': square(512, fill_ratio=0.72),
    'icons/apple-touch-icon-180.png': square(180),
    'icons/favicon-32.png': square(32),
}
for name, im in out.items():
    im.save(os.path.join(root, name), optimize=True)
    print(name, im.size, os.path.getsize(os.path.join(root, name)), 'bytes')
