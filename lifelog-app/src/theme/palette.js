// 主题色板：浅色 / 深色两套，字段名一致，页面只认字段不认具体色值。
// 深色不是把浅色简单反相：卡片/填充用「比底色略亮」的层级，文字用略带冷调的灰白，
// 品牌蓝在深色下提亮一档（0A84FF），保证深色背景上的可读性。

const light = {
  scheme: 'light',

  // 背景层级：环境光底色 → 玻璃卡片 → 更低的凹陷面（输入框/次级填充）
  bg: '#D6DFEA',
  bgElevated: 'rgba(255,255,255,0.58)',
  bgSunken: 'rgba(255,255,255,0.34)',
  fill: 'rgba(255,255,255,0.24)',
  fillStrong: 'rgba(255,255,255,0.40)',

  // 文字层级
  text: '#16202D',
  textStrong: '#0A1220',
  textSecondary: '#4F5C6D',
  textMuted: '#6C7889',
  textFaint: '#95A1AF',
  textOnAccent: '#FFFFFF',

  // 描边 / 分隔
  border: 'rgba(255,255,255,0.62)',
  borderSoft: 'rgba(255,255,255,0.40)',
  divider: 'rgba(22,32,45,0.10)',
  hairline: 'rgba(60,60,67,0.22)',

  // 品牌与语义色
  accent: '#0A84FF',
  accentSoft: 'rgba(10,132,255,0.14)',
  accentSoftBorder: 'rgba(10,132,255,0.32)',
  accentTint: 'rgba(10,132,255,0.08)',
  brand: '#2F7BF6',
  danger: '#E5484D',
  dangerSoft: 'rgba(239,68,68,0.14)',
  dangerSoftBorder: 'rgba(239,68,68,0.30)',
  purple: '#A855F7',
  purpleSoft: 'rgba(168,85,247,0.14)',
  purpleSoftBorder: 'rgba(168,85,247,0.30)',
  warnSoft: 'rgba(251,191,36,0.20)',
  warnText: '#B45309',
  success: '#34C759',
  star: '#FACC15',
  starEmpty: 'rgba(22,32,45,0.16)',

  // 类型图标底色（旅票/地点/娱乐）
  iconTicket: 'rgba(10,132,255,0.14)',
  iconTrip: 'rgba(249,115,22,0.14)',
  iconPlace: 'rgba(239,68,68,0.13)',
  iconMedia: 'rgba(168,85,247,0.14)',
  // 一级类型配色（列表标签、月示圆点）：一个一级类型一个颜色
  groupTicket: '#2F7BF6',
  groupPlace: '#EE4D3D',
  groupMedia: '#A855F7',
  groupNote: '#10B981',
  groupTicketSoft: 'rgba(10,132,255,0.14)',
  groupPlaceSoft: 'rgba(239,68,68,0.13)',
  groupMediaSoft: 'rgba(168,85,247,0.14)',
  groupNoteSoft: 'rgba(16,185,129,0.14)',

  // 遮罩 / 占位 / 阴影
  scrim: 'rgba(10,16,26,0.36)',
  overlay: 'rgba(10,16,26,0.42)',
  mediaPlaceholder: 'rgba(255,255,255,0.28)',
  shadow: '#1E2A3A',
  sheetHandle: 'rgba(255,255,255,0.70)',

  // 液态玻璃材质：底色、描边、高光与背景光团
  glassTint: 'rgba(255,255,255,0.12)',
  glassStrong: 'rgba(255,255,255,0.80)',
  surfaceDeep: '#8A98A9',
  glassBorder: 'rgba(255,255,255,0.72)',
  glassRow: 'rgba(255,255,255,0.62)',
  glassShadow: 'rgba(38,56,84,0.18)',
  glassSheen: ['rgba(255,255,255,0.48)', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.20)'],
  tabBarTint: 'rgba(255,255,255,0.38)',
  sidebarTint: 'rgba(246,250,255,0.46)',
  ambientGradient: ['#DCE6F2', '#C8D5E5', '#E8DFE8', '#C9D7E8'],
  ambientGlowTop: ['rgba(255,255,255,0.90)', 'rgba(255,255,255,0)'],
  ambientGlowBottom: ['rgba(162,146,196,0)', 'rgba(162,146,196,0.42)'],

  // 地图（注入 WebView 的配色）
  map: {
    bg: '#F2F2F7',
    controlBg: 'rgba(255,255,255,0.72)',
    controlText: '#374151',
    controlBorder: 'rgba(255,255,255,0.72)',
    cardBg: 'rgba(255,255,255,0.84)',
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

  bg: '#080A0F',
  bgElevated: 'rgba(22,28,38,0.62)',
  bgSunken: 'rgba(255,255,255,0.06)',
  fill: 'rgba(255,255,255,0.10)',
  fillStrong: 'rgba(255,255,255,0.18)',

  text: '#F5F7FB',
  textStrong: '#FFFFFF',
  textSecondary: '#B7C1CE',
  textMuted: '#95A1B1',
  textFaint: '#6B7787',
  textOnAccent: '#FFFFFF',

  border: 'rgba(255,255,255,0.16)',
  borderSoft: 'rgba(255,255,255,0.09)',
  divider: 'rgba(255,255,255,0.09)',
  hairline: 'rgba(255,255,255,0.18)',

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
  success: '#30D158',
  star: '#FACC15',
  starEmpty: 'rgba(255,255,255,0.18)',

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
  mediaPlaceholder: 'rgba(255,255,255,0.08)',
  shadow: '#000',
  sheetHandle: 'rgba(255,255,255,0.45)',

  glassTint: 'rgba(8,14,24,0.18)',
  glassStrong: 'rgba(16,22,32,0.88)',
  surfaceDeep: '#141B26',
  glassBorder: 'rgba(255,255,255,0.20)',
  glassRow: 'rgba(18,24,34,0.72)',
  glassShadow: 'rgba(0,0,0,0.50)',
  glassSheen: ['rgba(255,255,255,0.20)', 'rgba(255,255,255,0.02)', 'rgba(255,255,255,0.08)'],
  tabBarTint: 'rgba(10,14,22,0.55)',
  sidebarTint: 'rgba(12,18,28,0.62)',
  ambientGradient: ['#182232', '#0C111A', '#1A1528', '#090C12'],
  ambientGlowTop: ['rgba(80,124,190,0.35)', 'rgba(80,124,190,0)'],
  ambientGlowBottom: ['rgba(128,92,180,0)', 'rgba(128,92,180,0.30)'],

  map: {
    bg: '#0F1115',
    controlBg: 'rgba(22,28,38,0.80)',
    controlText: '#E5E7EB',
    controlBorder: 'rgba(255,255,255,0.18)',
    cardBg: 'rgba(20,26,36,0.90)',
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
