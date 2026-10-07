package expo.modules.paths

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

// 应用专属外部目录（/storage/emulated/0/Android/data/<包名>/files）的绝对路径。
//
// 存在意义：内部存储（/data/user/0/<包名>/files）没有 root 打不开，影像副本和封面
// 放在那里用户既看不见也拷不走；挪到应用专属外部目录后，手机文件管理器能直接翻到。
// （注意 Android 11+ 起部分机型的文件管理器和电脑 MTP 仍然进不去，这是系统限制。）
//
// 同步函数：JS 侧在模块加载时就要拿到路径（storagePaths.js 用的是同步常量），
// 调用本身只是拼路径，开销可忽略。外部存储未挂载或机型不支持时返回空串，
// 由 JS 回退到内部目录，不会崩。
//
// 下面几个函数是给 expo-file-system 擦屁股的：它对沙盒外的目标先做 File.canWrite()
// 判定，而"还不存在"的文件/目录一律判定为 false，导致往 Android/data 里新建目录、
// 复制一个新文件、写一个新文件全被拒（"Location ... isn't writable"）。
// 这里用原生 File API 做同一件事，路径只可能是我们拼出来的 App 私有目录，失败返回 false。
//
// deletePath 是同一类问题的另一面：expo-file-system 的 deleteAsync 会先检查
// "Uri.withAppendedPath(uri, \"..\")" 的写权限，而给一个**文件**路径拼上 ".." 之后
// File.canWrite() 的 stat 直接失败（不是因为没权限），于是 Android/data 里的文件
// 永远报 "Location ... isn't deletable." —— 表现就是"同步说清理了，文件却还在"。
// 删除 App 私有目录里的东西一律走这里（原生 File.deleteRecursively，文件/目录都行）。
class PathsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Paths")

    // 只读属性 + 同步函数两种取法都给，避免不同版本的 expo-modules-core 暴露方式有差别
    Property("externalFilesDir") { externalFilesDir() }

    Function("getExternalFilesDir") {
      externalFilesDir()
    }

    AsyncFunction("ensureDir") { uri: String ->
      runCatching {
        val dir = toFile(uri)
        dir.mkdirs() || dir.isDirectory
      }.getOrDefault(false)
    }

    AsyncFunction("copyFile") { from: String, to: String ->
      runCatching {
        val src = toFile(from)
        val dst = toFile(to)
        dst.parentFile?.mkdirs()
        src.copyTo(dst, overwrite = true)
        dst.exists()
      }.getOrDefault(false)
    }

    AsyncFunction("writeFileBase64") { uri: String, base64: String ->
      runCatching {
        val dst = toFile(uri)
        dst.parentFile?.mkdirs()
        dst.writeBytes(android.util.Base64.decode(base64, android.util.Base64.DEFAULT))
        true
      }.getOrDefault(false)
    }

    AsyncFunction("deletePath") { uri: String ->
      runCatching {
        val target = toFile(uri)
        if (!target.exists()) true else target.deleteRecursively()
      }.getOrDefault(false)
    }
  }

  private fun externalFilesDir(): String =
    appContext.reactContext?.getExternalFilesDir(null)?.absolutePath ?: ""

  private fun toFile(uri: String): File =
    File(Uri.parse(uri).path ?: uri.removePrefix("file://"))
}
