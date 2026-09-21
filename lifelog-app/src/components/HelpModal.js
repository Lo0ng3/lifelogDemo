import React from 'react';
import { View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme, useThemedStyles } from '../theme/ThemeProvider';

/* ------------------------------------------------------------------ *
 * 侧边栏「说明」
 *
 * 页面上不再放说明性的文字（提示、口径、Key 怎么配…），统一收到这里：
 * 想用某个功能时不受文字干扰，需要了解背景时点侧边栏的「说明」进来查。
 * 内容按主题分组，用数组维护，加一条就是加一行文字。
 * ------------------------------------------------------------------ */
const SECTIONS = [
  {
    title: '三种视图',
    items: [
      '列表：按日期倒序，每行显示完整日期（年-月-日）、类型标签、评分或心情和一行摘要；右滑可以「修改 / 删除」。',
      '日历：上半是月历（圆点按一级类型着色，最多 3 个 + N），下半是当月时间线；点某一天只看当天，再点一次回到整月；左右滑月历或点 ‹ › 换月，「今天」回到当天。',
      '地图：单击标点弹出内容卡，连点两次飞到该点并放大；同一坐标上的多条记录合并成一个标点，卡片里可以左右翻；右上角可以全屏。',
    ],
  },
  {
    title: '类型',
    items: [
      '一级类型四个：旅票 / 地点 / 娱乐 / 随笔。旅票分机票·火车票·汽车票·轮船，娱乐分电影·剧集·动漫·游戏·书籍，随笔分日记·事迹，地点不分子类。',
      '随笔不打分：心情必填（预设 5 个或自己填一个 emoji），日记多一个天气；标题选填，留空时取正文首行。',
      '旅票的副标题是航班号 / 车次，评论单独存一个字段；只有旅票记时分，其它类型的日期只到日。',
    ],
  },
  {
    title: '相关影像（详情页）',
    items: [
      '长按 260ms 后移动 = 调整顺序：手指落在哪一格，这张就插到那一格，其余影像保持相对顺序顺延补位；拖动时页面不会跟着滚动。',
      '长按后原地松手 = 设为封面（已经是封面时可以选择取消封面）。',
      '轻点 = 全屏查看：图片可以双指捏合缩放、双击放大 / 还原、放大后拖动，视频用系统播放控件。',
    ],
  },
  {
    title: '地点与行程的联想',
    items: [
      '出发地 / 目的地 / 地点名称的联想与定位，需要先在侧边栏「地图服务」里选好服务商并填入 Key；没填也能手写名称，只是不联想、不标点。',
      '地点印记的坐标优先取联想选中的地点，其次取新加照片里的 GPS，最后用名称做地理编码。',
    ],
  },
  {
    title: '地图服务与 Key',
    items: [
      '天地图：一把 tk 同时管底图和地名检索（WGS-84，无偏移）。',
      '高德：「Web 服务」Key 只用于地点联想 / 地理编码；「Web端(JS API)」Key + 安全密钥用来渲染底图（矢量渲染，缩放跟手，深色用官方深色样式）。后面这两把留空时自动用高德栅格瓦片（免 Key）。',
      'JS API 没能出图会自动切回栅格底图并在顶部说明原因，不会白屏。',
      '坐标统一存 WGS-84，用高德底图显示时自动转 GCJ-02，两家之间来回切换不会跑偏。',
      'Key 只保存在本机，换机后需要重新填写。',
    ],
  },
  {
    title: '从系统分享进来',
    items: [
      '在图库 / 相册里选好照片或视频 → 分享 → 选「印记」，App 会被拉起（或从后台回到前台）并弹出「分享到印记」，两种去处：新建印记（影像挂到添加表单的照片区，类型 / 日期 / 评论照常自己填）；添加到已有记录（选一条记录，这些影像追加到它的「相关影像」末尾）。',
      '同一张照片只挂一条记录，已经记过的影像会自动跳过。',
      '分享进来的影像会先复制一份到应用私有目录，保存或添加时按 文件名·大小·尺寸 重链回相册原片，重链成功就把副本删掉；在「分享到印记」里取消，副本也一并删除。',
    ],
  },
  {
    title: '相册影像不复制',
    items: [
      '应用内选图器直接读相册，只记录资产引用（assetId），不复制文件；显示时实时解析相册里的原片。',
      '选图器默认只展示相机 / 视频 / 截图等常用相册，微信、QQ 之类的缓存相册收在「更多相册 / 缓存相册」里，需要时点「显示」找回。',
      '系统只放开了部分照片（「仅允许访问部分照片」）时，选图器里也只能看到已授权的那一部分。',
    ],
  },
  {
    title: '重复记录提醒',
    items: [
      '同一天已经记过同一个地点、同一段行程（含同航班号 / 车次）或同一部作品时，表单里会出现一条可点的提醒，点它可以先看一眼已有的那条。',
      '只是提醒，不拦保存：同一个地点改天再去、同一部作品二刷，照样可以再记一条。',
    ],
  },
  {
    title: '同步相册影像',
    items: [
      '换机、重装或从旧版本升级后，记录里的影像可能会断链。这一步会扫描相册，把还能对上的重新关联到原片，并删掉应用里的本地副本释放空间。',
      '结果里会列出找不到原片的记录（原片可能已经被删），这些需要在对应记录里重新添加影像。',
    ],
  },
  {
    title: '备份与恢复',
    items: [
      '导出备份：把全部记录（含封面小图）写成一个 JSON 文件，存到指定目录。',
      '导入备份：可选「覆盖现有」或「合并去重」（同 id 以备份里的为准）；换机后导入完建议再点一次「同步相册影像」把影像重新关联回相册。',
    ],
  },
  {
    title: '清理缓存',
    items: [
      '清理封面帧、实况提取、图片浏览缓存和地图瓦片，并报告释放了多少空间。',
      '清掉的都是可再生内容：封面帧在用的时候会自动重建，地图下次打开重新下载瓦片；记录、照片引用、地图 Key 都不受影响。',
    ],
  },
  {
    title: '外观',
    items: [
      '跟随系统深浅色：白天浅色、夜间深色。开屏图与页面底色一致，启动不会先闪一下再跳色。',
    ],
  },
];

export default function HelpModal({ visible, onClose }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerSide} />
          <Text style={styles.headerTitle}>说明</Text>
          <TouchableOpacity style={styles.headerSide} onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <X size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
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
  headerTitle: { fontSize: 17, fontWeight: '600', color: c.text },
  content: { padding: 16, paddingBottom: 40 },
  card: { backgroundColor: c.bgElevated, borderRadius: 14, padding: 16, marginBottom: 12 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 10 },
  item: { fontSize: 13.5, lineHeight: 21, color: c.textSecondary, marginBottom: 8 },
});
