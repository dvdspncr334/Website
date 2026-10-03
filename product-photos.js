// In-memory image preparation. No upload or browser storage is performed here.
export const PHOTO_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  maxCount: 12,
  maxPixels: 40 * 1000 * 1000,
  maxDimension: 2000,
  quality: 0.9
});

export function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return 'image/png';
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  return '';
}

export function checkPhotoBatch(files, existing = [], options = {}) {
  const limits = { ...PHOTO_LIMITS, ...options };
  if (existing.length + files.length > limits.maxCount) throw new Error(`Choose at most ${limits.maxCount} photos.`);
  if (files.some(file => !file.size || file.size > limits.maxFileBytes)) {
    throw new Error(`Each photo must be nonempty and at most ${Math.floor(limits.maxFileBytes / 1024 / 1024)} MB.`);
  }
  const total = [...existing, ...files].reduce((sum, file) => sum + (file.originalSize ?? file.size ?? file.blob?.size ?? 0), 0);
  if (total > limits.maxTotalBytes) throw new Error('The combined photos exceed the total size limit.');
}

export function photoPath(id, type, cryptoApi = globalThis.crypto) {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) throw new Error('Choose a valid product ID before saving photos.');
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
  if (!extension) throw new Error('Unsupported image format.');
  if (!cryptoApi?.getRandomValues) throw new Error('Secure random image names are unavailable.');
  const random = cryptoApi.getRandomValues(new Uint8Array(16));
  const name = [...random].map(n => n.toString(16).padStart(2, '0')).join('');
  return `images/products/${id}/${name}.${extension}`;
}

async function decodePhoto(blob) {
  if (typeof globalThis.createImageBitmap === 'function') {
    return globalThis.createImageBitmap(blob, { imageOrientation: 'from-image' });
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('This image could not be decoded.'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function encodePhoto(image, width, height, type, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image processing is unavailable.');
  // PNG/WebP keep their alpha channel; JPEG is intentionally opaque.
  context.drawImage(image, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('Image processing failed.')), type, quality
  ));
}

export async function preparePhoto(file, options = {}) {
  const limits = { ...PHOTO_LIMITS, ...options };
  checkPhotoBatch([file], [], limits);
  if (!/\.(jpe?g|png|webp)$/i.test(file.name || '')) throw new Error('Choose a JPEG, PNG or WebP image file.');
  const type = imageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  const expected = /\.png$/i.test(file.name) ? 'image/png' : /\.webp$/i.test(file.name) ? 'image/webp' : 'image/jpeg';
  if (!type || type !== expected || (file.type && file.type.toLowerCase() !== type)) {
    throw new Error('The image contents, filename and file type must match (JPEG, PNG or WebP).');
  }
  if (!Number.isFinite(limits.maxDimension) || limits.maxDimension < 1 ||
      !Number.isFinite(limits.quality) || limits.quality < 0.1 || limits.quality > 1) {
    throw new Error('Choose a valid resize dimension and quality.');
  }
  let image;
  try {
    image = await (options.decode || decodePhoto)(file);
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > limits.maxPixels) {
      throw new Error('This image has invalid or excessively large dimensions.');
    }
    const ratio = options.keepOriginal ? 1 : Math.min(1, limits.maxDimension / Math.max(width, height));
    const resizedWidth = Math.max(1, Math.round(width * ratio));
    const resizedHeight = Math.max(1, Math.round(height * ratio));
    const blob = options.keepOriginal ? file : await (options.encode || encodePhoto)(
      image, resizedWidth, resizedHeight, type, limits.quality
    );
    if (!blob?.size || blob.size > limits.maxFileBytes) throw new Error('The processed image exceeds the per-file limit.');
    // Some browsers fall back to PNG if their encoder does not support WebP.
    const outputType = blob.type || type;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(outputType)) throw new Error('Unsupported processed image type.');
    return {
      blob, type: outputType, width: resizedWidth, height: resizedHeight,
      originalWidth: width, originalHeight: height, originalSize: file.size,
      name: file.name, previewUrl: (options.urlApi || URL).createObjectURL(blob), state: 'pending'
    };
  } catch (error) {
    throw new Error(error?.message || 'This image could not be decoded.');
  } finally {
    image?.close?.();
  }
}
