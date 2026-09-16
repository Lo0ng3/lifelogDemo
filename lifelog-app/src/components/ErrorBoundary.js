import React from 'react';
import { View, Text, ScrollView, StyleSheet, Appearance } from 'react-native';

// 类组件里拿不到 hook，直接读系统外观：报错页也跟随深/浅色，夜里不至于白到刺眼
const isDark = () => Appearance.getColorScheme() === 'dark';

// 全局错误边界：release 包里 JS 报错不会显示红框，这里把错误信息显示出来，
// 方便远程定位问题（正式用户体验上也不至于直接闪退无提示）
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('App crashed:', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      const styles = makeStyles(isDark());
      return (
        <View style={styles.container}>
          <Text style={styles.title}>应用遇到了一个错误</Text>
          <ScrollView style={styles.box}>
            <Text style={styles.errorText}>
              {String(this.state.error?.message || this.state.error)}
              {'\n\n'}
              {String(this.state.error?.stack || '')}
            </Text>
          </ScrollView>
          <Text style={styles.hint}>请将以上内容截图反馈</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const makeStyles = (dark) => StyleSheet.create({
  container: { flex: 1, backgroundColor: dark ? '#0F1115' : '#F2F2F7', padding: 24, paddingTop: 60 },
  title: { fontSize: 18, fontWeight: '700', color: dark ? '#F2F3F5' : '#1C1C1E', marginBottom: 12 },
  box: { flex: 1, backgroundColor: dark ? '#1B1D22' : '#FFF', borderRadius: 10, padding: 12 },
  errorText: { fontSize: 12, color: dark ? '#FF6B6B' : '#EF4444', fontFamily: 'monospace' },
  hint: { fontSize: 12, color: dark ? '#8B919C' : '#8E8E93', marginTop: 10, textAlign: 'center' },
});
