// 底部 TabBar 的统一外观。
// 单独抽出来是因为「地图全屏」时要把 TabBar 藏起来（display:none），
// 退出全屏得把这份样式原样装回去——两边共用同一个函数，避免两处颜色写歪。
import { StyleSheet } from 'react-native';

export const tabBarStyleFor = (colors) => ({
  position: 'absolute',
  left: '50%',
  marginLeft: -120,
  bottom: 16,
  width: 240,
  height: 54,
  paddingTop: 4,
  paddingBottom: 4,
  backgroundColor: 'transparent',
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.glassBorder,
  borderRadius: 21,
  overflow: 'hidden',
  shadowColor: colors.glassShadow,
  shadowOffset: { width: 0, height: 14 },
  shadowOpacity: 0.9,
  shadowRadius: 24,
  elevation: 10,
});

export const HIDDEN_TAB_BAR = { display: 'none' };
