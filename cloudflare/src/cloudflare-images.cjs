const fs = require('node:fs/promises');
const path = require('node:path');
const { getBindings } = require('./context.cjs');

const formats = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp', 'avif']);
let allowedFormats;
function stream(buffer) {
  return new Blob([buffer]).stream();
}
function binding() {
  const images = getBindings().IMAGES;
  if (!images) throw new Error('Cloudflare Images binding is required for image processing');
  return images;
}
function setAllowedDecoders(loaders) {
  if (loaders === null) {
    allowedFormats = undefined;
    return;
  }
  const names = {
    Png: 'png',
    Svg: 'svg+xml',
    Jpeg: 'jpeg',
    Gif: 'gif',
    Webp: 'webp',
    Heif: 'avif',
    Tiff: 'tiff',
  };
  allowedFormats = new Set(
    loaders.map((loader) => names[loader.replace(/^VipsForeignLoad/, '')]).filter(Boolean),
  );
}
async function imageInfo(buffer) {
  const info = await binding().info(stream(buffer));
  const format = info.format.replace(/^image\//, '');
  if (allowedFormats && !allowedFormats.has(format))
    throw new Error(`Image decoder is disabled: ${format}`);
  return { ...info, format };
}
async function resizeFromBuffer(original, options = {}) {
  const info = await imageInfo(original);
  const format = options.format === 'jpg' ? 'jpeg' : options.format || info.format;
  if (!formats.has(format)) throw new Error(`Unsupported image output format: ${format}`);
  const image = binding()
    .input(stream(original))
    .transform({
      ...(options.width ? { width: options.width } : {}),
      ...(options.height ? { height: options.height } : {}),
      fit: options.withoutEnlargement === false ? 'cover' : 'scale-down',
    });
  const output = await image.output({
    format: `image/${format}`,
    anim: options.animated ?? ['gif', 'webp'].includes(format),
  });
  const result = Buffer.from(await output.response().arrayBuffer());
  return options.format || result.length < original.length ? result : original;
}
async function resizeFromPath(options) {
  const original = await fs.readFile(options.in);
  await fs.writeFile(options.out, await resizeFromBuffer(original, options));
}
function generateOriginalImageName(filename) {
  const parsed = path.parse(filename);
  return path.join(parsed.dir, `${parsed.name}_o${parsed.ext}`);
}

module.exports = {
  setAllowedDecoders,
  canTransformFiles() {
    try {
      return Boolean(getBindings().IMAGES);
    } catch {
      return false;
    }
  },
  canTransformFileExtension: (ext) => !['.ico'].includes(ext),
  shouldResizeFileExtension: (ext) => !['.ico', '.svg', '.svgz'].includes(ext),
  canTransformToFormat: (format) => formats.has(format),
  generateOriginalImageName,
  resizeFromBuffer,
  resizeFromPath,
  DEFAULT_PROCESSING_TIMEOUT_SECONDS: 0,
  getSharp() {
    return require('./gift-image.cjs').giftSharp;
  },
};
