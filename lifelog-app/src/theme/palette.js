// 主题色板（冰川极简 · Apple Liquid Native）：
// 浅色用清透冷雾白（#F4F6F9）+ 纯白分组卡片 + 深海靛蓝点缀（#1D63ED）；
// 深色用深邃石墨黑（#0B0D11）+ 提亮一层卡片（#161920）+ 亮冰蓝（#4B8BFF）；
// 与苹果原生 UIGlassEffect 液态玻璃及原生分段控键浑然一体。

const light = {
  scheme: 'light',

  // 背景层级：冰川雾白页面底 → 纯白卡片 → 柔和次级凹陷面
  bg: '#F4F6F9',
  bgElevated: '#FFFFFF',
  bgSunken: '#EDF0F5',
  fill: '#E6EAF0',
  fillStrong: '#D5DCE6',

  // 文字层级
  text: '#1A1D23',
  textStrong: '#0B0D12',
  textSecondary: '#5E6675',
  textMuted: '#8E96A4',
  textFaint: '#B8C0CE',
  textOnAccent: '#FFFFFF',

  // 描边 / 分隔
  border: '#E4E8EF',
  borderSoft: '#EEF1F6',
  divider: '#EFF2F6',
  hairline: 'rgba(26,29,35,0.14)',

  // 品牌与语义色
  accent: '#1D63ED',
  accentSoft: '#E6EFFF',
  accentSoftBorder: '#C4DAFF',
  accentTint: '#F2F7FF',
  brand: '#1D63ED',
  danger: '#DC4C46',
  dangerSoft: '#FDECEC',
  dangerSoftBorder: '#FACACA',
  purple: '#8B5CF6',
  purpleSoft: '#F1EBFE',
  purpleSoftBorder: '#DFD1FD',
  warnSoft: '#FEF5DF',
  warnText: '#A86209',
  orange: '#EA7A2E',
  success: '#109B6A',
  star: '#F5B400',
  starEmpty: '#E4E8EF',

  // 类型图标底色（旅票/地点/娱乐）
  iconTicket: '#E6EFFF',
  iconTrip: '#FFF0E3',
  iconPlace: '#FDECEC',
  iconMedia: '#F1EBFE',
  // 一级类型配色（列表标签、月示圆点）：清透克制的冰川色阶
  groupTicket: '#1D63ED',
  groupPlace: '#DC4C46',
  groupMedia: '#8B5CF6',
  groupNote: '#109B6A',
  groupTicketSoft: '#E6EFFF',
  groupPlaceSoft: '#FDECEC',
  groupMediaSoft: '#F1EBFE',
  groupNoteSoft: '#E4F7F0',

  // 遮罩 / 占位 / 阴影
  scrim: 'rgba(11,13,18,0.36)',
  overlay: 'rgba(11,13,18,0.42)',
  mediaPlaceholder: '#E6EAF0',
  shadow: '#0B1220',
  sheetHandle: '#C9D0DC',

  // 地图（注入 WebView 的配色）
  map: {
    bg: '#F4F6F9',
    controlBg: 'rgba(255,255,255,0.92)',
    controlText: '#1A1D23',
    controlBorder: 'rgba(26,29,35,0.12)',
    cardBg: '#FFFFFF',
    cardText: '#1A1D23',
    cardMeta: '#7A8394',
    cardNote: '#4A5260',
    bannerBg: '#FEF5DF',
    bannerText: '#8A5A12',
    dotBorder: '#FFFFFF',
    tileFilter: 'none',
  },
};

const dark = {
  scheme: 'dark',

  bg: '#0B0D11',
  bgElevated: '#161920',
  bgSunken: '#1F232C',
  fill: '#262B36',
  fillStrong: '#343B49',

  text: '#F1F4F9',
  textStrong: '#FFFFFF',
  textSecondary: '#9BA3B4',
  textMuted: '#6F7788',
  textFaint: '#505766',
  textOnAccent: '#FFFFFF',

  border: '#272C37',
  borderSoft: '#20242E',
  divider: '#20242E',
  hairline: 'rgba(255,255,255,0.13)',

  accent: '#4B8BFF',
  accentSoft: 'rgba(75,139,255,0.18)',
  accentSoftBorder: 'rgba(75,139,255,0.36)',
  accentTint: 'rgba(75,139,255,0.12)',
  brand: '#5C98FF',
  danger: '#FF7B75',
  dangerSoft: 'rgba(255,123,117,0.16)',
  dangerSoftBorder: 'rgba(255,123,117,0.32)',
  purple: '#B794FF',
  purpleSoft: 'rgba(183,148,255,0.16)',
  purpleSoftBorder: 'rgba(183,148,255,0.32)',
  warnSoft: 'rgba(251,191,36,0.16)',
  warnText: '#FBBF24',
  orange: '#FB923C',
  success: '#3ED6A1',
  star: '#FACC15',
  starEmpty: '#323845',

  iconTicket: 'rgba(75,139,255,0.18)',
  iconTrip: 'rgba(251,146,60,0.18)',
  iconPlace: 'rgba(255,123,117,0.16)',
  iconMedia: 'rgba(183,148,255,0.16)',
  groupTicket: '#5C98FF',
  groupPlace: '#FF7B75',
  groupMedia: '#B794FF',
  groupNote: '#3ED6A1',
  groupTicketSoft: 'rgba(92,152,255,0.18)',
  groupPlaceSoft: 'rgba(255,123,117,0.16)',
  groupMediaSoft: 'rgba(183,148,255,0.16)',
  groupNoteSoft: 'rgba(62,214,161,0.16)',

  scrim: 'rgba(0,0,0,0.62)',
  overlay: 'rgba(0,0,0,0.62)',
  mediaPlaceholder: '#262B36',
  shadow: '#000',
  sheetHandle: '#454C5B',

  map: {
    bg: '#0B0D11',
    controlBg: 'rgba(22,25,32,0.92)',
    controlText: '#E5E9F2',
    controlBorder: 'rgba(255,255,255,0.12)',
    cardBg: '#161920',
    cardText: '#F1F4F9',
    cardMeta: '#8F98A8',
    cardNote: '#C5CCD9',
    bannerBg: 'rgba(251,191,36,0.14)',
    bannerText: '#FBBF24',
    dotBorder: '#161920',
    // 天地图只有浅色矢量底图：深色下用标准滤镜把瓦片压成深色，避免整块地图在夜里刺眼
    tileFilter: 'invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.92) saturate(0.85)',
  },
};

export const palettes = { light, dark };
export const getPalette = (scheme) => (scheme === 'dark' ? dark : light);
