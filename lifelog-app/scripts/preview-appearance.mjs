// 生成外观预览页：开屏（浅色 / 深色）+ 界面色板对照。
// 颜色直接取自 src/theme/palette.js，不会和 App 里的实际用色跑偏。
// 用法：node scripts/preview-appearance.mjs  →  demo/appearance-preview.html
import { writeFileSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const scratch = mkdtempSync(join(tmpdir(), 'rc-appearance-'));
const target = join(scratch, 'palette.mjs');
copyFileSync(join(root, 'src/theme/palette.js'), target);
const { palettes } = await import(pathToFileURL(target).href);

const SWATCHES = [
  ['bg', '页面底色'],
  ['bgElevated', '卡片 / 列表'],
  ['bgSunken', '输入框 / 次级填充'],
  ['fill', '搜索框 / 分段控件'],
  ['text', '正文文字'],
  ['textSecondary', '次要文字'],
  ['border', '描边'],
  ['accent', '强调色'],
  ['accentSoft', '强调色浅底'],
  ['danger', '地点 / 危险'],
  ['purple', '娱乐 / 阅读'],
  ['star', '评分'],
];

const swatchRows = (c) => SWATCHES.map(([key, label]) => `
        <div class="sw">
          <span class="chip" style="background:${c[key]}"></span>
          <span class="name">${label}</span>
          <code>${c[key]}</code>
        </div>`).join('');

const phone = (scheme, c) => `
    <div class="phone ${scheme}">
      <div class="screen" style="background:${c.bg}">
        <div class="splash" style="background:${scheme === 'dark' ? '#0F1115' : '#F2F2F7'}">
          <img src="../assets/images/splash-icon-${scheme === 'dark' ? 'dark' : 'light'}.png" alt="开屏图标" />
          <div class="splashTag">开屏 · ${scheme === 'dark' ? '夜间' : '白天'}</div>
        </div>
        <div class="ui">
          <div class="card" style="background:${c.bgElevated};border-color:${c.border}">
            <div class="row">
              <div class="dot" style="background:${c.accentSoft}"></div>
              <div style="flex:1">
                <div class="title" style="color:${c.text}">外滩 &amp; 南京东路</div>
                <div class="sub" style="color:${c.textSecondary}">10-02 · 风很大，夜景绝美</div>
              </div>
            </div>
            <div class="row">
              <div class="dot" style="background:${c.dangerSoft}"></div>
              <div style="flex:1">
                <div class="title" style="color:${c.text}">北京 → 上海</div>
                <div class="sub" style="color:${c.textSecondary}">MU5101 · 2023-10-01</div>
              </div>
            </div>
          </div>
          <div class="search" style="background:${c.fill};color:${c.textMuted}">搜索标题、关键字…</div>
        </div>
      </div>
      <div class="cap">${scheme === 'dark' ? '深色（夜间 / 手动固定）' : '浅色（白天 / 跟随系统）'}</div>
    </div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>印记 · 外观（浅色 / 深色）预览</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 24px 56px; background: #EEF0F3; color: #1C1C1E;
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  h1 { font-size: 21px; margin: 0 0 6px; }
  .sub { font-size: 13px; color: #5B6472; line-height: 1.75; max-width: 900px; margin-bottom: 26px; }
  h2 { font-size: 16px; margin: 34px 0 14px; }
  .cols { display: flex; gap: 28px; flex-wrap: wrap; align-items: flex-start; }
  .phone { width: 300px; flex: none; border: 7px solid #14161A; border-radius: 32px; overflow: hidden; background: #14161A; }
  .screen { height: 470px; display: flex; flex-direction: column; }
  .splash { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; }
  .splash img { width: 120px; height: 120px; }
  .splashTag { font-size: 11px; color: #8E8E93; letter-spacing: .04em; }
  .ui { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .card { border: 1px solid; border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
  .row { display: flex; align-items: center; gap: 10px; }
  .dot { width: 32px; height: 32px; border-radius: 8px; flex: none; }
  .title { font-size: 14px; font-weight: 600; }
  .sub { font-size: 11.5px; margin-top: 2px; }
  .search { border-radius: 8px; padding: 8px 10px; font-size: 12px; }
  .cap { text-align: center; color: #C9CDD4; font-size: 12px; padding: 10px 0 12px; }
  .panel { display: flex; gap: 28px; flex-wrap: wrap; }
  .swatches { background: #FFF; border-radius: 14px; padding: 18px; box-shadow: 0 1px 4px rgba(0,0,0,.06); min-width: 300px; }
  .swatches h3 { font-size: 14px; margin: 0 0 12px; }
  .sw { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 12.5px; }
  .chip { width: 22px; height: 22px; border-radius: 6px; border: 1px solid rgba(0,0,0,.12); flex: none; }
  .name { width: 92px; color: #3C4149; }
  .sw code { color: #6B7280; font-size: 11.5px; }
</style>
</head>
<body>
  <h1>印记 · 外观预览</h1>
  <p class="sub">
    开屏与界面都跟随系统深/浅色（<b>白天浅色、夜间深色</b>），也可以在侧边栏「外观」里手动固定成浅色或深色。
    开屏底色与页面底色一致（浅色 #F2F2F7 / 深色 #0F1115），启动过程不会先闪一下再跳色。
  </p>

  <h2>开屏 + 列表界面</h2>
  <div class="cols">
${phone('light', palettes.light)}
${phone('dark', palettes.dark)}
  </div>

  <h2>色板对照</h2>
  <div class="panel">
    <div class="swatches"><h3>浅色</h3>${swatchRows(palettes.light)}</div>
    <div class="swatches"><h3>深色</h3>${swatchRows(palettes.dark)}</div>
  </div>
</body>
</html>
`;

mkdirSync(join(root, 'demo'), { recursive: true });
const out = join(root, 'demo/appearance-preview.html');
writeFileSync(out, html, 'utf8');
console.log(`已生成 ${out}`);
