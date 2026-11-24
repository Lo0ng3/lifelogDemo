// 主题色板：浅色 / 深色两套，字段名一致，页面只认字段不认具体色值。
// 深色不是把浅色简单反相：卡片/填充用「比底色略亮」的层级，文字用略带冷调的灰白，
// 品牌蓝在深色下提亮一档（0A84FF），保证深色背景上的可读性。

const light = {
  scheme: 'light',

  // 背景层级：页面底色 → 卡片 → 更低的凹陷面（输入框/次级填充）
  bg: '#F2F2F7',
  bgElevated: '#FFFFFF',
  bgSunken: '#F9FAFB',
  fill: '#E5E5EA',
  fillStrong: '#D1D5DB',

  // 文字层级
  text: '#1C1C1E',
  textStrong: '#000000',
  textSecondary: '#6B7280',
  textMuted: '#9CA3AF',
  textFaint: '#C7CAD1',
  textOnAccent: '#FFFFFF',

  // 描边 / 分隔
  border: '#E5E7EB',
  borderSoft: '#F3F4F6',
  divider: '#F2F2F7',
  hairline: 'rgba(60,60,67,0.29)',

  // 品牌与语义色
  accent: '#007AFF',
  accentSoft: '#E0F2FE',
  accentSoftBorder: '#BAE6FD',
  accentTint: '#F0F8FF',
  brand: '#2F7BF6',
  danger: '#EF4444',
  dangerSoft: '#FEE2E2',
  dangerSoftBorder: '#FECACA',
  purple: '#A855F7',
  purpleSoft: '#F3E8FF',
  purpleSoftBorder: '#E9D5FF',
  warnSoft: '#FEF3C7',
  warnText: '#B45309',
  orange: '#F97316',
  success: '#34C759',
  star: '#FACC15',
  starEmpty: '#E5E7EB',

  // 类型图标底色（旅票/地点/娱乐）
  iconTicket: '#E0F2FE',
  iconTrip: '#FFEDD5',
  iconPlace: '#FEE2E2',
  iconMedia: '#F3E8FF',
  // 一级类型配色（列表标签、月示圆点）：一个一级类型一个颜色
  groupTicket: '#2F7BF6',
  groupPlace: '#EE4D3D',
  groupMedia: '#A855F7',
  groupNote: '#10B981',
  groupTicketSoft: '#E0F2FE',
  groupPlaceSoft: '#FEE2E2',
  groupMediaSoft: '#F3E8FF',
  groupNoteSoft: '#D1FAE5',

  // 遮罩 / 占位 / 阴影
  scrim: 'rgba(0,0,0,0.4)',
  overlay: 'rgba(0,0,0,0.45)',
  mediaPlaceholder: '#E5E5EA',
  shadow: '#000',
  sheetHandle: '#D1D5DB',

  // 地图（注入 WebView 的配色）
  map: {
    bg: '#F2F2F7',
    controlBg: 'rgba(255,255,255,0.94)',
    controlText: '#374151',
    controlBorder: 'rgba(60,60,67,0.16)',
    cardBg: '#FFFFFF',
    cardText: '#1C1C1E',
    cardMeta: '#8E8E93',
    cardNote: '#374151',
    bannerBg: '#FFF7E6',
    bannerText: '#8A6D3B',
    dotBorder: '#FFFFFF',
    tileFilter: 'none',
  },
};

const dark = {
  scheme: 'dark',

  bg: '#0F1115',
  bgElevated: '#1B1D22',
  bgSunken: '#23262C',
  fill: '#2C2F36',
  fillStrong: '#3A3E46',

  text: '#F2F3F5',
  textStrong: '#FFFFFF',
  textSecondary: '#A6ACB8',
  textMuted: '#8B919C',
  textFaint: '#6B7280',
  textOnAccent: '#FFFFFF',

  border: '#2E323A',
  borderSoft: '#262A31',
  divider: '#262A31',
  hairline: 'rgba(255,255,255,0.14)',

  accent: '#0A84FF',
  accentSoft: 'rgba(10,132,255,0.18)',
  accentSoftBorder: 'rgba(10,132,255,0.36)',
  accentTint: 'rgba(10,132,255,0.12)',
  brand: '#4C93FF',
  danger: '#FF6B6B',
  dangerSoft: 'rgba(255,107,107,0.16)',
  dangerSoftBorder: 'rgba(255,107,107,0.32)',
  purple: '#C084FC',
  purpleSoft: 'rgba(192,132,252,0.16)',
  purpleSoftBorder: 'rgba(192,132,252,0.32)',
  warnSoft: 'rgba(251,191,36,0.16)',
  warnText: '#FBBF24',
  orange: '#FB923C',
  success: '#30D158',
  star: '#FACC15',
  starEmpty: '#3A3E46',

  iconTicket: 'rgba(10,132,255,0.18)',
  iconTrip: 'rgba(249,115,22,0.18)',
  iconPlace: 'rgba(255,107,107,0.18)',
  iconMedia: 'rgba(192,132,252,0.18)',
  groupTicket: '#4C93FF',
  groupPlace: '#FF6B6B',
  groupMedia: '#C084FC',
  groupNote: '#34D399',
  groupTicketSoft: 'rgba(10,132,255,0.18)',
  groupPlaceSoft: 'rgba(255,107,107,0.16)',
  groupMediaSoft: 'rgba(192,132,252,0.16)',
  groupNoteSoft: 'rgba(52,211,153,0.16)',

  scrim: 'rgba(0,0,0,0.6)',
  overlay: 'rgba(0,0,0,0.6)',
  mediaPlaceholder: '#2C2F36',
  shadow: '#000',
  sheetHandle: '#48484A',

  map: {
    bg: '#0F1115',
    controlBg: 'rgba(28,30,35,0.94)',
    controlText: '#E5E7EB',
    controlBorder: 'rgba(255,255,255,0.12)',
    cardBg: '#1B1D22',
    cardText: '#F2F3F5',
    cardMeta: '#9BA1AC',
    cardNote: '#C7CBD3',
    bannerBg: 'rgba(251,191,36,0.14)',
    bannerText: '#FBBF24',
    dotBorder: '#1B1D22',
    // 天地图只有浅色矢量底图：深色下用标准滤镜把瓦片压成深色，避免整块地图在夜里刺眼
    tileFilter: 'invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.92) saturate(0.85)',
  },
};

export const palettes = { light, dark };

export const getPalette = (scheme) => (scheme === 'dark' ? dark : light);
