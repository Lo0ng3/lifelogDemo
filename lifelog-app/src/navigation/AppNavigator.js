import React, { useMemo } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { NavigationContainer, DefaultTheme, DarkTheme, createNavigationContainerRef } from '@react-navigation/native';
import { Compass, PlusCircle } from 'lucide-react-native';

// 引入我们刚才写的两个页面
import HomeScreen from '../screens/HomeScreen';
import AddScreen from '../screens/AddScreen';
import DetailScreen from '../screens/DetailScreen';
import MediaPickerScreen from '../screens/MediaPickerScreen';
import ShareTargetScreen from '../screens/ShareTargetScreen';
import { useTheme } from '../theme/ThemeProvider';
import { tabBarStyleFor } from './tabBarStyle';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// 导航 ref：分享进来的影像要在「任意页面」都能跳到「添加」页（见 ShareIntentBridge），
// 那时拿不到组件的 navigation prop，只能走这个全局 ref
export const navigationRef = createNavigationContainerRef();

function Tabs() {
  const { colors } = useTheme();
  return (
    <Tab.Navigator
      screenOptions={{
        // Tab 之间用轻微的位移过渡，比硬切更顺；键盘弹出时收起 TabBar
        animation: 'shift',
        tabBarHideOnKeyboard: true,
        // 配置底部导航栏的样式（跟随主题）
        tabBarActiveTintColor: colors.accent, // 选中时的颜色
        tabBarInactiveTintColor: colors.textMuted,  // 未选中时的颜色
        tabBarStyle: tabBarStyleFor(colors),
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600', marginTop: -1 },
        tabBarItemStyle: { paddingVertical: 0 },
        tabBarIconStyle: { marginBottom: -1 },
        headerShown: false, // 隐藏默认的顶部标题栏，我们后续自己画
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarLabel: '印记',
          tabBarIcon: ({ color, size }) => (
            <Compass color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Add"
        component={AddScreen}
        options={{
          tabBarLabel: '添加',
          tabBarIcon: ({ color, size }) => (
            <PlusCircle color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const { colors, isDark } = useTheme();

  // 让导航容器本身也换上主题色：页面切换时露出的底色、返回手势的阴影都跟着变
  const navTheme = useMemo(() => {
    const base = isDark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: isDark,
      colors: {
        ...base.colors,
        primary: colors.accent,
        background: colors.bg,
        card: colors.bgElevated,
        text: colors.text,
        border: colors.border,
        notification: colors.danger,
      },
    };
  }, [colors, isDark]);

  return (
    <NavigationContainer theme={navTheme} ref={navigationRef}>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          // 统一的页面切换动画：二级页面从右侧滑入；背景色跟随主题，转场时不会闪白
          animation: 'slide_from_right',
          animationDuration: 300,
          gestureEnabled: true,
          fullScreenGestureEnabled: true,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {/* 底部 Tab 作为根；详情/编辑/选图为二级页面，进出配对，返回栈不会越叠越深 */}
        <Stack.Screen name="Main" component={Tabs} />
        <Stack.Screen name="Detail" component={DetailScreen} />
        {/* 编辑复用添加表单，作为独立栈页：保存/取消/返回都直接回主界面 */}
        <Stack.Screen name="Edit" component={AddScreen} />
        {/* 相册直读选图器：应用内浏览相册，只记录 assetId 全程零复制 */}
        <Stack.Screen name="MediaPicker" component={MediaPickerScreen} />
        {/* 系统分享的落点：新建印记，或把分享进来的影像追加到某条已有记录 */}
        {/* 关掉侧滑返回：这一页退出时要把分享进来的副本删掉，只走页面自己的取消/返回 */}
        <Stack.Screen name="ShareTarget" component={ShareTargetScreen} options={{ gestureEnabled: false }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
