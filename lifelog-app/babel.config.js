module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // 注意：react-native-reanimated/plugin 必须放在插件列表的最后一行！
      'react-native-reanimated/plugin',
    ],
  };
};