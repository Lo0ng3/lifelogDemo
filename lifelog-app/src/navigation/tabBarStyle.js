// 底部 TabBar 的统一外观。
// 单独抽出来是因为「地图全屏」时要把 TabBar 藏起来（display:none），
// 退出全屏得把这份样式原样装回去——两边共用同一个函数，避免两处颜色写歪。
import { Dimensions, StyleSheet } from 'react-native';

const BAR_WIDTH = 220;
const windowWidth = Dimensions.get('window').width;

export const tabBarStyleFor = (colors) => ({
  position: 'absolute',
  // 不用 left:50% + marginLeft：部分 Android 版本会把百分比当成 0，
  // 结果整条导航被推到屏幕外，只剩“添加”露出来。直接用窗口宽度算固定左边距。
  left: Math.max(16, (windowWidth - BAR_WIDTH) / 2),
  bottom: 18,
  width: BAR_WIDTH,
  height: 56,
  paddingTop: 4,
  paddingBottom: 4,
  backgroundColor: 'transparent',
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
