import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { NavigationContainer } from '@react-navigation/native';
import { Compass, PlusCircle } from 'lucide-react-native';

// 引入我们刚才写的两个页面
import HomeScreen from '../screens/HomeScreen';
import AddScreen from '../screens/AddScreen';
import DetailScreen from '../screens/DetailScreen';
import MediaPickerScreen from '../screens/MediaPickerScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        // 配置底部导航栏的样式
        tabBarActiveTintColor: '#007AFF', // 选中时的颜色
        tabBarInactiveTintColor: 'gray',  // 未选中时的颜色
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
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          // 统一的页面切换动画：二级页面从右侧滑入，时长收敛到 260ms，不拖沓
          animation: 'slide_from_right',
          animationDuration: 260,
        }}
      >
        {/* 底部 Tab 作为根；详情/编辑/选图为二级页面，进出配对，返回栈不会越叠越深 */}
        <Stack.Screen name="Main" component={Tabs} />
        <Stack.Screen name="Detail" component={DetailScreen} />
        {/* 编辑复用添加表单，作为独立栈页：保存/取消/返回都直接回主界面 */}
        <Stack.Screen name="Edit" component={AddScreen} />
        {/* 相册直读选图器：应用内浏览相册，只记录 assetId 全程零复制 */}
        <Stack.Screen name="MediaPicker" component={MediaPickerScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
