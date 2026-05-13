import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { Compass, PlusCircle } from 'lucide-react-native';

// 引入我们刚才写的两个页面
import HomeScreen from '../screens/HomeScreen';
import AddScreen from '../screens/AddScreen';

const Tab = createBottomTabNavigator();

export default function AppNavigator() {
  return (
    <NavigationContainer>
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
    </NavigationContainer>
  );
}