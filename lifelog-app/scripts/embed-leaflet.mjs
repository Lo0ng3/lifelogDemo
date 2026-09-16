// 把 vendor/leaflet 下的 Leaflet 产物内联成 App 内的 JS 模块。
//
// 为什么这样做：地图是 WebView + Leaflet 渲染的，库本身原来走 CDN（jsdelivr），
// 国内网络下经常拉不到，结果是整张地图连同标点一起空白。
// 内联进 JS bundle 后不依赖任何网络，也不用 expo-asset 读文件，启动即可用。
//
// 用法：node scripts/embed-leaflet.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const version = JSON.parse(read('vendor/leaflet/package.json')).version;
const js = read('vendor/leaflet/leaflet.min.js');
const css = read('vendor/leaflet/leaflet.min.css');

// 注入到 <script>/<style> 里，遇到会提前闭合标签的序列先拆开
const guard = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--').replace(/<\/style/gi, '<\\/style');

const out = `// 由 scripts/embed-leaflet.mjs 自动生成，请勿手改。
// Leaflet ${version}（BSD-2-Clause）—— 本地打包，避免 CDN 在国内不可达导致地图空白。

export const LEAFLET_VERSION = ${JSON.stringify(version)};
export const LEAFLET_JS = ${JSON.stringify(guard(js))};
export const LEAFLET_CSS = ${JSON.stringify(guard(css))};
`;

mkdirSync(join(root, 'src/vendor'), { recursive: true });
writeFileSync(join(root, 'src/vendor/leafletBundle.js'), out, 'utf8');
console.log(`Leaflet ${version} 已内联：js ${js.length} / css ${css.length} 字节`);
