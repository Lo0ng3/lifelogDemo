// 底部 TabBar 的统一外观。
// 单独抽出来是因为「地图全屏」时要把 TabBar 藏起来（display:none），
// 退出全屏得把这份样式原样装回去——两边共用同一个函数，避免两处颜色写歪。
import { StyleSheet } from 'react-native';

export const tabBarStyleFor = (colors) => ({
  backgroundColor: 'transparent',
  borderTopColor: colors.glassBorder,
  borderTopWidth: StyleSheet.hairlineWidth,
});

export const HIDDEN_TAB_BAR = { display: 'none' };
