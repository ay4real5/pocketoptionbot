from pathlib import Path
import shutil
import struct
import zlib

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / 'extension_dist'


def icon_png():
    pixels = bytearray()
    for y in range(128):
        pixels.append(0)
        for x in range(128):
            bar = (24 <= x < 42 and 76 <= y < 104) or (54 <= x < 72 and 52 <= y < 104) or (84 <= x < 102 and 24 <= y < 104)
            pixels.extend((125, 216, 197, 255) if bar else (11, 16, 20, 255))
    def chunk(kind, value):
        return struct.pack('!I', len(value)) + kind + value + struct.pack('!I', zlib.crc32(kind + value) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 128, 128, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(bytes(pixels))) + chunk(b'IEND', b''))


def build():
    OUTPUT.mkdir(exist_ok=True)
    for name in ('manifest.json', 'policy.js', 'worker.js', 'bridge.js', 'chart_probe.js', 'panel.css', 'panel.html', 'panel.js'):
        shutil.copyfile(ROOT / 'extension' / name, OUTPUT / name)
    for name in ('screen_analysis.js', 'chart_alerts.js', 'screen_capture.js'):
        shutil.copyfile(ROOT / 'static' / name, OUTPUT / name)
    (OUTPUT / 'icon128.png').write_bytes(icon_png())
    print(f'Built unpacked extension: {OUTPUT}')
    print('No API keys, pairing tokens, account data or captured images are included.')


if __name__ == '__main__':
    build()
