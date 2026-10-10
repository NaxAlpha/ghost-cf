import { initWasm, Resvg } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm?module';

let initialized;
export async function rasterizeSvg(bytes) {
  initialized ??= initWasm(wasm);
  await initialized;
  const renderer = new Resvg(bytes, { font: { loadSystemFonts: false } });
  let rendered;
  try {
    rendered = renderer.render();
    return Buffer.from(rendered.asPng());
  } finally {
    rendered?.free();
    renderer.free();
  }
}
