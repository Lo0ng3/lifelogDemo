// 底部 TabBar 的统一外观。
// 单独抽出来是因为「地图全屏」时要把 TabBar 藏起来（display:none），
// 退出全屏得把这份样式原样装回去——两边共用同一个函数，避免两处颜色写歪。
import { StyleSheet } from 'react-native';

export const tabBarStyleFor = (colors) => ({
  position: 'absolute',
  left: '50%',
  marginLeft: -110,
  bottom: 18,
  width: 220,
  height: 56,
  paddingTop: 4,
  paddingBottom: 4,
  backgroundColor: colors.bgElevated,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.border,
  borderRadius: 22,
  overflow: 'hidden',
  shadowColor: colors.shadow,
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.16,
  shadowRadius: 20,
  elevation: 9,
});

export const HIDDEN_TAB_BAR = { display: 'none' };
