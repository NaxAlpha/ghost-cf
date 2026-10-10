const fs = require('node:fs/promises');
const { getBindings } = require('./context.cjs');

function decodeXml(value) {
  return value.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_match, entity) =>
      ({
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      })[entity],
  );
}
async function sourceHandle(input) {
  const { IMAGES, GIFT_FONT_URL } = getBindings();
  if (!IMAGES) throw new Error('Cloudflare Images is required for gift previews');
  if (input?.text) {
    const markup = input.text.text;
    const span =
      /^<span foreground="([^"]+)" font_desc="Inter (Bold|Medium) (\d+)">([\s\S]*)<\/span>$/.exec(
        markup,
      );
    if (!span) throw new Error('Unsupported gift text markup');
    if (!GIFT_FONT_URL) throw new Error('Gift font URL is required');
    return IMAGES.text(decodeXml(span[4]), {
      font: { url: GIFT_FONT_URL },
      color: span[1],
      size: Number(span[3]),
    });
  }
  let bytes = typeof input === 'string' ? await fs.readFile(input) : input;
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/.test(Buffer.from(bytes).toString('utf8', 0, 256))) {
    if (!getBindings().RASTERIZE_SVG)
      throw new Error('SVG rasterizer is required for gift previews');
    bytes = await getBindings().RASTERIZE_SVG(bytes);
  }
  return IMAGES.input(new Blob([bytes]).stream());
}

// Implements the small Sharp surface used by Ghost's unchanged gift renderer.
// This is not a general native Sharp replacement.
function giftSharp(input) {
  const operations = [];
  let timeoutSeconds;
  const chain = {
    resize(width, height, options = {}) {
      operations.push({ kind: 'resize', width, height, options });
      return chain;
    },
    composite(overlays) {
      operations.push({ kind: 'composite', overlays });
      return chain;
    },
    png() {
      return chain;
    },
    timeout({ seconds }) {
      timeoutSeconds = seconds;
      return chain;
    },
    async toBuffer() {
      let timer;
      const render = async () => {
        let handle = await sourceHandle(input);
        for (const operation of operations) {
          if (operation.kind === 'resize') {
            handle = handle.transform({
              ...(operation.width ? { width: operation.width } : {}),
              ...(operation.height ? { height: operation.height } : {}),
              fit: operation.options.withoutEnlargement ? 'scale-down' : 'cover',
            });
          } else {
            for (const overlay of operation.overlays) {
              const image = await sourceHandle(overlay.input);
              handle = handle.draw(image, {
                ...(overlay.left !== undefined ? { left: overlay.left } : {}),
                ...(overlay.top !== undefined ? { top: overlay.top } : {}),
                ...(overlay.tile ? { repeat: true } : {}),
              });
            }
          }
        }
        const output = await handle.output({ format: 'image/png', anim: false });
        return Buffer.from(await output.response().arrayBuffer());
      };
      try {
        return await (timeoutSeconds
          ? Promise.race([
              render(),
              new Promise((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Gift preview processing timed out')),
                  timeoutSeconds * 1000,
                );
              }),
            ])
          : render());
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return chain;
}
module.exports = { giftSharp };
