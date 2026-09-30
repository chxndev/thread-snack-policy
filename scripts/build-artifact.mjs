// jaso/index.html + style.css → jaso/dist/artifact.html (claude.ai 아티팩트용 페이지 본문)
// 아티팩트 도구가 doctype/head/body 골격을 씌우므로, <title>과 <style>을 맨 앞에 두고 본문만 담는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jaso');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

const title = (html.match(/<title>([^<]*)<\/title>/) ?? [, '자소서 에이전트'])[1];
const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error('body not found');
let body = bodyMatch[1].trim();
// 모듈 스크립트는 게시된 파일 경로(src/app.js)를 가리키게 한다
body = body.replace(/<script type="module" src="\.\/src\/app\.js"><\/script>/, '<script type="module" src="src/app.js"></script>');

const out = `<title>${title}</title>\n<style>\n${css}\n</style>\n${body}\n`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), out);
console.log(`wrote jaso/dist/artifact.html (${out.length} chars)`);
