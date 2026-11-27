import { afterEach, describe, expect, it, vi } from 'vitest';
import { preparePhotoBlob, readJpegExifOrientation } from './imagePrep.ts';

function buildJpegWithOrientation(orientation: number): ArrayBuffer {
  const bytes = new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe1, // APP1
    0x00,
    0x1e, // length = 30
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x4d,
    0x4d, // Big-endian TIFF ("MM")
    0x00,
    0x2a, // TIFF magic 42
    0x00,
    0x00,
    0x00,
    0x08, // IFD0 offset = 8
    0x00,
    0x01, // 1 IFD entry
    0x01,
    0x12, // tag = Orientation (0x0112)
    0x00,
    0x03, // type = SHORT
    0x00,
    0x00,
    0x00,
    0x01, // count = 1
    0x00,
    orientation,
    0x00,
    0x00, // value
    0xff,
    0xd9, // EOI
  ]);
  return bytes.buffer;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('imagePrep', () => {
  it('reads EXIF orientation from JPEG headers and defaults cleanly to 1', () => {
    expect(readJpegExifOrientation(buildJpegWithOrientation(6))).toBe(6);
    expect(readJpegExifOrientation(buildJpegWithOrientation(3))).toBe(3);
    expect(readJpegExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBe(1);
  });

  it('refuses to proceed when an image blob is empty or canvas encoding fails', async () => {
    await expect(preparePhotoBlob(new Blob([]))).rejects.toThrow();

    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode error')));
    vi.stubGlobal(
      'Image',
      class FakeImage {
        onerror: (() => void) | null = null;
        set src(_val: string) {
          queueMicrotask(() => this.onerror?.());
        }
      }
    );

    await expect(preparePhotoBlob(new Blob(['bad'], { type: 'image/jpeg' }))).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it('redraws upright image shrunk to <= 1568px through canvas', async () => {
    const fakeCtx = {
      fillStyle: '',
      fillRect: vi.fn(),
      save: vi.fn(),
      transform: vi.fn(),
      drawImage: vi.fn(),
      restore: vi.fn(),
    };
    const createdCanvases: Array<{ width: number; height: number }> = [];

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        const fakeCanvas = {
          width: 0,
          height: 0,
          getContext: () => fakeCtx,
          toBlob: (cb: (b: Blob | null) => void) =>
            cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })),
          toDataURL: () => 'data:image/jpeg;base64,/9j/2Q==',
        } as unknown as HTMLCanvasElement;
        createdCanvases.push(fakeCanvas);
        return fakeCanvas;
      }
      return origCreateElement(tagName);
    });

    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 3136, height: 1568, close: vi.fn() }));

    const prepared = await preparePhotoBlob(new Blob(['fake-jpeg'], { type: 'image/jpeg' }));
    expect(prepared.width).toBe(1568);
    expect(prepared.height).toBe(784);
    expect(prepared.imageDataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(createdCanvases[1].width).toBe(320);
    vi.unstubAllGlobals();
  });
});
