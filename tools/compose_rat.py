"""Stacks rat layers into one picture, the way exfil.fun/rat draws a rat.

    pip install pillow
    python3 tools/compose_rat.py cute tint-gold kit-night hat-crown -o my-rat.png
    python3 tools/compose_rat.py --list

The first name is the base rat. Fur tints (tint-*), kits (kit-*) and hats
(hat-*) fit the cute and pixel bases only; every base has a gold crown
(crown-gold). Layers go on in the order given, all on one shared canvas.
"""
import argparse
import json
import os

from PIL import Image

LAYERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'rats', 'layers')


def main():
    manifest = json.load(open(os.path.join(LAYERS, 'manifest.json')))
    layers = manifest['layers']
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('base', nargs='?', help='base rat, e.g. cute, pixel, ronin, biker')
    parser.add_argument('extras', nargs='*', help='e.g. tint-gold kit-night hat-crown crown-gold')
    parser.add_argument('-o', '--out', default='rat.png')
    parser.add_argument('--list', action='store_true', help='list every base and layer')
    args = parser.parse_args()

    if args.list or not args.base:
        bases = sorted(n[5:] for n in layers if n.startswith('base-'))
        print('bases: ' + ' '.join(bases))
        for kind in ('tint', 'kit', 'hat'):
            names = sorted({n.rsplit('-', 1)[0] for n in layers if n.startswith(kind + '-')})
            print(f'{kind} (cute, pixel): ' + ' '.join(names))
        print('crown: crown-gold (every base)')
        return

    canvas = Image.new('RGBA', (manifest['canvas']['w'], manifest['canvas']['h']))
    for name in ['base'] + args.extras:
        key = f'{name}-{args.base}'
        if key not in layers:
            raise SystemExit(f'no layer {key}; try --list')
        at = layers[key]
        layer = Image.open(os.path.join(LAYERS, f'{key}.png')).convert('RGBA')
        canvas.alpha_composite(layer, (at['x'], at['y']))
    canvas.crop(canvas.getbbox()).save(args.out)
    print(f'wrote {args.out}')


if __name__ == '__main__':
    main()
