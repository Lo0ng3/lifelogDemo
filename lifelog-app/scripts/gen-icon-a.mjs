// 生成图标 A「航线」的全套应用图标资源（node scripts/gen-icon-a.mjs）
// 需要一次性安装：npm i --no-save sharp
import sharp from 'sharp';

const SIZE = 1024;

// 图标 A 的内容层（透明底）：虚线航弧 + 起终点 + 飞机
// color=主色 / innerDot=起点内点颜色，便于生成品牌蓝的启动屏版本
const content = (color = '#FFFFFF', innerDot = '#2F7BF6') => `
    <path d="M 210 790 C 400 720, 470 560, 560 430 C 640 310, 720 250, 826 220"
          fill="none" stroke="${color}" stroke-opacity="0.55" stroke-width="13"
          stroke-dasharray="2 36" stroke-linecap="round"/>
    <circle cx="210" cy="790" r="38" fill="${color}"/>
    <circle cx="210" cy="790" r="15" fill="${innerDot}"/>
    <circle cx="826" cy="220" r="18" fill="${color}"/>
    <g transform="translate(430 218) scale(15) rotate(42 12 12)">
      <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
            fill="${color}"/>
    </g>`;

const bgGradient = `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#123B7A"/><stop offset="1" stop-color="#2F7BF6"/>
      </linearGradient>
    </defs>`;

const svgWrap = (inner, transparentBg = false) => `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
    ${transparentBg ? '' : bgGradient}
    ${transparentBg ? '' : '<rect width="1024" height="1024" fill="url(#bg)"/>'}
    ${inner}
  </svg>`;

// 自适应图标前景/单色层：内容缩到中心 72%，落在 Android 安全区（半径 33%）内
const fgScale = 0.72;
const fgOffset = (SIZE * (1 - fgScale) / 2).toFixed(1);
const foregroundInner = `<g transform="translate(${fgOffset} ${fgOffset}) scale(${fgScale})">${content()}</g>`;

const targets = [
  // 主应用图标（iOS / Android 传统图标 / Web）
  { file: 'assets/images/icon.png', svg: svgWrap(content()), size: 1024 },
  // Android 自适应图标：背景=渐变，前景=内容（安全区内）
  { file: 'assets/images/android-icon-background.png', svg: svgWrap(''), size: 1024 },
  { file: 'assets/images/android-icon-foreground.png', svg: svgWrap(foregroundInner, true), size: 1024 },
  // Android 13 主题图标：单色白色内容
  { file: 'assets/images/android-icon-monochrome.png', svg: svgWrap(foregroundInner, true), size: 1024 },
  // 启动屏：品牌蓝图标内容（白底上可见）
  {
    file: 'assets/images/splash-icon.png',
    svg: svgWrap(`<g transform="translate(133 133) scale(0.74)">${content('#2F7BF6', '#FFFFFF')}</g>`, true),
    size: 512,
  },
  { file: 'assets/images/favicon.png', svg: svgWrap(content()), size: 48 },
];

for (const t of targets) {
  await sharp(Buffer.from(t.svg.trim())).resize(t.size, t.size).png().toFile(t.file);
  console.log('生成', t.file, `${t.size}x${t.size}`);
}
console.log('完成');
