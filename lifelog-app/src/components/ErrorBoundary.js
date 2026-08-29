import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';

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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7', padding: 24, paddingTop: 60 },
  title: { fontSize: 18, fontWeight: '700', color: '#1C1C1E', marginBottom: 12 },
  box: { flex: 1, backgroundColor: '#FFF', borderRadius: 10, padding: 12 },
  errorText: { fontSize: 12, color: '#EF4444', fontFamily: 'monospace' },
  hint: { fontSize: 12, color: '#8E8E93', marginTop: 10, textAlign: 'center' },
});
