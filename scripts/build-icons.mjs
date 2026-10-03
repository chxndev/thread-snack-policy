// jaso/icons/icon.svg → PWA·홈 화면 아이콘 PNG (Playwright 의 Chromium 으로 그린다)
//   icon-192.png, icon-512.png  : 둥근 모서리, 바깥은 투명 (manifest purpose "any")
//   icon-512-maskable.png       : 모서리 없이 꽉 찬 배경 + 안전 영역(가운데 지름 80% 원) 안으로 줄인 글자 (purpose "maskable")
//   icon-180.png                : 애플 터치 아이콘 — iOS 가 모서리를 직접 깎으므로 투명 없이 꽉 찬 배경
// 사용: node scripts/build-icons.mjs  (PLAYWRIGHT_BROWSERS_PATH 의 Chromium 사용, 네트워크 불필요)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jaso', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

/** 배경 모서리를 없앤다 (rect#bg 의 rx → 0) */
function squareBackground(src) {
  const out = src.replace(/(<rect id="bg"[^>]*?)\srx="[^"]*"/, '$1 rx="0"');
  if (out === src) throw new Error('icon.svg 에서 <rect id="bg" ... rx="..."> 를 찾지 못했습니다');
  return out;
}

/** 글자(g#mark)를 가운데 기준으로 줄인다 */
function scaleMark(src, factor) {
  const out = src.replace(/<g id="mark"/, `<g transform="translate(256 256) scale(${factor}) translate(-256 -256)"><g id="mark"`).replace(/(<g id="mark"[\s\S]*?<\/g>)/, '$1</g>');
  if (out === src) throw new Error('icon.svg 에서 <g id="mark"> 를 찾지 못했습니다');
  return out;
}

const targets = [
  { file: 'icon-192.png', size: 192, svg },
  { file: 'icon-512.png', size: 512, svg },
  { file: 'icon-512-maskable.png', size: 512, svg: scaleMark(squareBackground(svg), 0.72), opaque: true },
  { file: 'icon-180.png', size: 180, svg: squareBackground(svg), opaque: true },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const t of targets) {
    await page.setViewportSize({ width: t.size, height: t.size });
    const sized = t.svg.replace(/<svg([^>]*?)\swidth="[^"]*"\sheight="[^"]*"/, `<svg$1 width="${t.size}" height="${t.size}"`);
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${sized}</body></html>`);
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: t.size, height: t.size }, omitBackground: !t.opaque, type: 'png' });
    fs.writeFileSync(path.join(dir, t.file), buf);
    console.log(`wrote jaso/icons/${t.file} (${t.size}×${t.size}, ${buf.length} bytes)`);
  }
} finally {
  await browser.close();
}
