package expo.modules.paths

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// 应用专属外部目录（/storage/emulated/0/Android/data/<包名>/files）的绝对路径。
//
// 存在意义：内部存储（/data/user/0/<包名>/files）没有 root 打不开，影像副本和封面
// 放在那里用户既看不见也拷不走；挪到应用专属外部目录后，手机文件管理器能直接翻到。
// （注意 Android 11+ 起部分机型的文件管理器和电脑 MTP 仍然进不去，这是系统限制。）
//
// 同步函数：JS 侧在模块加载时就要拿到路径（storagePaths.js 用的是同步常量），
// 调用本身只是拼路径，开销可忽略。外部存储未挂载或机型不支持时返回空串，
// 由 JS 回退到内部目录，不会崩。
class PathsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Paths")

    Function("getExternalFilesDir") {
      appContext.reactContext?.getExternalFilesDir(null)?.absolutePath ?: ""
    }
  }
}
