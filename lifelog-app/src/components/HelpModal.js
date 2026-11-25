import React from 'react';
import { View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import NativeIcon from './NativeIcon';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';

// 精简功能说明：只介绍如何使用各模块，不列历史变更与内部实现细节
const SECTIONS = [
  {
    title: '三种视图',
    items: [
      '列表：按日期倒序浏览全部印记，支持关键字搜索与按类型筛选，点开即可查看详情、修改或删除。',
      '日历：上半为月历（圆点按记录类型着色），下半为当月时间线；点某一天可单看当天，点击顶部年月可快速跳转。',
      '地图：展示去过的地点与出行轨迹；单击标点弹出记录卡并可左右翻页，双击放大聚焦，右上角可全屏，右下角可按出行方式筛选轨迹。',
    ],
  },
  {
    title: '记录类型',
    items: [
      '旅票：机票、火车票、汽车票、轮船，支持起终点搜索、班次/车次与具体时分。',
      '地点：记录去过的地方，自动关联坐标并在地图上标点。',
      '娱乐与阅读：电影、剧集、动漫、游戏、书籍，输入名称可自动搜索补全与获取封面。',
      '随笔：日记与事迹，选择心情 emoji 即可自由记录，支持全屏写长文。',
    ],
  },
  {
    title: '照片与实况',
    items: [
      '直接读取系统相册原片，不在应用内重复复制照片，节省手机存储空间。',
      '详情页九宫格支持长按拖动调整顺序、长按原地松手设为封面、轻点全屏双指缩放与播放实况/视频。',
      '支持在系统相册中直接通过「分享 → 印记」快速新建印记或追加到已有记录。',
    ],
  },
  {
    title: '同步相册照片',
    items: [
      '换机或重装后，点「同步相册照片」可扫描系统相册重新关联原片，并清理多余的本地副本。',
      '若系统相册只授予了部分访问权限，改为「所有照片」后再同步即可完整关联。',
    ],
  },
  {
    title: '备份与恢复',
    items: [
      Platform.OS === 'ios'
        ? '导出备份：将全部记录、封面小图与个人资料打包为 JSON，可通过系统分享存到「文件」App、iCloud 或隔空投送。'
        : '导出备份：将全部记录、封面小图、个人资料与地图配置导出为 JSON 文件。',
      '导入备份：支持「合并去重」或「覆盖现有」；照片本体依赖系统相册，导入后建议执行一次「同步相册照片」。',
    ],
  },
  {
    title: '存储与清理',
    items: [
      '数据与存储：查看应用数据、图片缓存与临时文件的占用明细，并支持按项手动删除不需要的文件。',
      '清理缓存：释放视频封面帧、图片缓存、临时文件与无引用/重复封面，不影响已有记录。',
    ],
  },
  ...(Platform.OS === 'ios'
    ? []
    : [{
        title: '地图服务',
        items: [
          '支持天地图与高德地图，可在「我的 → 地图服务」中配置对应 Key 以启用地点联想与矢量底图。',
        ],
      }]),
  {
    title: '外观',
    items: [
      '在「我的」中可自由切换浅色、深色或跟随系统外观。',
    ],
  },
];

export default function HelpModal({ visible, onClose }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      onRequestClose={onClose}
    >
      <View style={[styles.container, { paddingTop: Platform.OS === 'ios' ? 0 : insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerSide} />
          <Text style={styles.headerTitle}>使用说明</Text>
          <TouchableOpacity style={styles.headerSide} onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <NativeIcon name="xmark" fallback={X} size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} bounces={Platform.OS === 'ios'} contentContainerStyle={styles.content}>
          {SECTIONS.map((section) => (
            <View key={section.title} style={styles.card}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.items.map((line, i) => (
                <Text key={i} style={styles.item}>{line}</Text>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (c) => ({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, backgroundColor: c.bgElevated,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  headerSide: { width: 32, alignItems: 'flex-end' },
  headerTitle: { fontSize: 17, fontWeight: '600', color: c.textStrong },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: c.bgElevated, borderRadius: 16, padding: 16, marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 10 },
  item: { fontSize: 13.5, lineHeight: 21, color: c.textSecondary, marginBottom: 8 },
});
