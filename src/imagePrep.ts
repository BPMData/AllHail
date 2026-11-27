export const MAX_UPLOAD_SIDE_PX = 1568;
export const THUMBNAIL_SIDE_PX = 320;
export const UPLOAD_JPEG_QUALITY = 0.82;
export const THUMBNAIL_JPEG_QUALITY = 0.7;
export const MAX_DECODED_BYTES = 4 * 1024 * 1024;

export type PreparedPhoto = {
  imageDataUrl: string;
  thumbnailDataUrl: string;
  width: number;
  height: number;
  byteLength: number;
};

/**
 * Reads JPEG EXIF Orientation tag (1..8) from the first 64 KB when createImageBitmap
 * orientation handling is unavailable. Returns 1 (normal) if not found.
 */
export function readJpegExifOrientation(buffer: ArrayBuffer): number {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || view.getUint16(0, false) !== 0xffd8) {
    return 1;
  }
  let offset = 2;
  const maxOffset = Math.min(view.byteLength, 65536);

  while (offset + 4 <= maxOffset) {
    const marker = view.getUint16(offset, false);
    offset += 2;
    if (marker === 0xffe1) {
      if (offset + 8 > view.byteLength) return 1;
      const exifHeader = view.getUint32(offset + 2, false);
      if (exifHeader !== 0x45786966) return 1; // "Exif"
      const tiffStart = offset + 8;
      if (tiffStart + 8 > view.byteLength) return 1;
      const littleEndian = view.getUint16(tiffStart, false) === 0x4949;
      const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
      const dirStart = tiffStart + ifdOffset;
      if (dirStart + 2 > view.byteLength) return 1;
      const entries = view.getUint16(dirStart, littleEndian);
      for (let i = 0; i < entries; i += 1) {
        const entryOffset = dirStart + 2 + i * 12;
        if (entryOffset + 12 > view.byteLength) return 1;
        if (view.getUint16(entryOffset, littleEndian) === 0x0112) {
          const val = view.getUint16(entryOffset + 8, littleEndian);
          return val >= 1 && val <= 8 ? val : 1;
        }
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00) break;
    if (offset + 2 > view.byteLength) break;
    const size = view.getUint16(offset, false);
    if (size < 2) break;
    offset += size;
  }
  return 1;
}

function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    throw new Error('Image has invalid dimensions');
  }
  const longest = Math.max(width, height);
  if (longest <= maxSide) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function applyExifTransform(
  ctx: CanvasRenderingContext2D,
  orientation: number,
  drawWidth: number,
  drawHeight: number
): void {
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, drawWidth, 0);
      break;
    case 3:
      ctx.transform(-1, 0, 0, -1, drawWidth, drawHeight);
      break;
    case 4:
      ctx.transform(1, 0, 0, -1, 0, drawHeight);
      break;
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.transform(0, 1, -1, 0, drawHeight, 0);
      break;
    case 7:
      ctx.transform(0, -1, -1, 0, drawHeight, drawWidth);
      break;
    case 8:
      ctx.transform(0, -1, 1, 0, 0, drawWidth);
      break;
    default:
      break;
  }
}

async function canvasToJpegDataUrl(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<{ dataUrl: string; byteLength: number }> {
  const blob = await new Promise<Blob | null>((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((result) => resolve(result), 'image/jpeg', quality);
    } else {
      resolve(null);
    }
  });

  if (blob && blob.size > 0) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string' && reader.result.startsWith('data:image/jpeg;base64,')) {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to encode JPEG data URL'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read encoded JPEG blob'));
      reader.readAsDataURL(blob);
    });
    return { dataUrl, byteLength: blob.size };
  }

  // Fallback for environments where toBlob is unavailable.
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  if (!dataUrl.startsWith('data:image/jpeg;base64,')) {
    throw new Error('Canvas did not produce a JPEG data URL');
  }
  const base64 = dataUrl.slice('data:image/jpeg;base64,'.length);
  const byteLength = Math.floor((base64.length * 3) / 4);
  if (byteLength <= 0) {
    throw new Error('Encoded JPEG was empty');
  }
  return { dataUrl, byteLength };
}

function drawSourceToCleanCanvas(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  orientation: number,
  maxSide: number
): HTMLCanvasElement {
  const swapped = orientation >= 5 && orientation <= 8;
  const uprightW = swapped ? srcHeight : srcWidth;
  const uprightH = swapped ? srcWidth : srcHeight;
  const target = fitWithin(uprightW, uprightH, maxSide);

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable');
  }

  // White matte ensures transparent PNGs flatten cleanly into JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);

  const drawW = swapped ? target.height : target.width;
  const drawH = swapped ? target.width : target.height;
  ctx.save();
  applyExifTransform(ctx, orientation, drawW, drawH);
  ctx.drawImage(source, 0, 0, drawW, drawH);
  ctx.restore();

  return canvas;
}

async function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => reject(new Error('Timed out decoding image')), 15_000);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Failed to decode image'));
      };
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Turns any user-selected photo upright, shrinks it to <= 1,568 px, and redraws
 * pixels into a fresh JPEG so zero EXIF, GPS, or camera metadata leaves the device.
 */
export async function preparePhotoBlob(blob: Blob): Promise<PreparedPhoto> {
  if (!blob || blob.size === 0) {
    throw new Error('No image data');
  }

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      try {
        const uploadCanvas = drawSourceToCleanCanvas(bitmap, bitmap.width, bitmap.height, 1, MAX_UPLOAD_SIDE_PX);
        const thumbCanvas = drawSourceToCleanCanvas(bitmap, bitmap.width, bitmap.height, 1, THUMBNAIL_SIDE_PX);
        const upload = await canvasToJpegDataUrl(uploadCanvas, UPLOAD_JPEG_QUALITY);
        const thumb = await canvasToJpegDataUrl(thumbCanvas, THUMBNAIL_JPEG_QUALITY);
        if (upload.byteLength > MAX_DECODED_BYTES) {
          throw new Error('Prepared image exceeds 4 MB limit');
        }
        return {
          imageDataUrl: upload.dataUrl,
          thumbnailDataUrl: thumb.dataUrl,
          width: uploadCanvas.width,
          height: uploadCanvas.height,
          byteLength: upload.byteLength,
        };
      } finally {
        bitmap.close?.();
      }
    } catch {
      // Fall through to HTMLImageElement + manual EXIF orientation parser.
    }
  }

  const headSlice = await blob.slice(0, 65536).arrayBuffer();
  const orientation = readJpegExifOrientation(headSlice);
  const img = await loadImageElement(blob);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const uploadCanvas = drawSourceToCleanCanvas(img, srcW, srcH, orientation, MAX_UPLOAD_SIDE_PX);
  const thumbCanvas = drawSourceToCleanCanvas(img, srcW, srcH, orientation, THUMBNAIL_SIDE_PX);
  const upload = await canvasToJpegDataUrl(uploadCanvas, UPLOAD_JPEG_QUALITY);
  const thumb = await canvasToJpegDataUrl(thumbCanvas, THUMBNAIL_JPEG_QUALITY);

  if (upload.byteLength > MAX_DECODED_BYTES) {
    throw new Error('Prepared image exceeds 4 MB limit');
  }

  return {
    imageDataUrl: upload.dataUrl,
    thumbnailDataUrl: thumb.dataUrl,
    width: uploadCanvas.width,
    height: uploadCanvas.height,
    byteLength: upload.byteLength,
  };
}

/**
 * Captures a clean, metadata-free JPEG directly from an active live video element.
 */
export async function prepareVideoFrame(video: HTMLVideoElement): Promise<PreparedPhoto> {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (!srcW || !srcH) {
    throw new Error('Camera frame is not ready yet');
  }
  const uploadCanvas = drawSourceToCleanCanvas(video, srcW, srcH, 1, MAX_UPLOAD_SIDE_PX);
  const thumbCanvas = drawSourceToCleanCanvas(video, srcW, srcH, 1, THUMBNAIL_SIDE_PX);
  const upload = await canvasToJpegDataUrl(uploadCanvas, UPLOAD_JPEG_QUALITY);
  const thumb = await canvasToJpegDataUrl(thumbCanvas, THUMBNAIL_JPEG_QUALITY);

  if (upload.byteLength > MAX_DECODED_BYTES) {
    throw new Error('Prepared image exceeds 4 MB limit');
  }

  return {
    imageDataUrl: upload.dataUrl,
    thumbnailDataUrl: thumb.dataUrl,
    width: uploadCanvas.width,
    height: uploadCanvas.height,
    byteLength: upload.byteLength,
  };
}
