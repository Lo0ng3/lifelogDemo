package expo.modules.thumbs

import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.util.Size
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

// 系统微缩略图管道：contentResolver.loadThumbnail 是系统相册/选择器同款的封面来源，
// 系统已经为绝大多数照片/视频生成过微缩略图，读取是毫秒级的——
// 相比解码原图（一张 5~20MB）快一个数量级以上。生成结果落盘 cacheDir/thumbs，重复请求零开销。
class ThumbsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Thumbs")

    AsyncFunction("getThumbnailAsync") { assetId: Double, isVideo: Boolean, size: Double, promise: Promise ->
      Thread {
        try {
          val context = appContext.reactContext
            ?: throw Exception("应用上下文不可用")
          // loadThumbnail 需要 API 29+；更旧的系统返回 null，由 JS 回退到原图显示
          if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            promise.resolve(null)
            return@Thread
          }

          val id = assetId.toLong()
          val contentUri = if (isVideo) {
            Uri.parse("content://media/external/video/media/$id")
          } else {
            Uri.parse("content://media/external/images/media/$id")
          }

          val px = size.toInt().coerceIn(64, 1024)
          val dir = File(context.cacheDir, "thumbs").apply { mkdirs() }
          val dest = File(dir, "thumb_${if (isVideo) "v" else "i"}_${id}_$px.jpg")
          if (!dest.exists() || dest.length() == 0L) {
            val bitmap = context.contentResolver.loadThumbnail(contentUri, Size(px, px), null)
            FileOutputStream(dest).use { out ->
              bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
            }
            bitmap.recycle()
          }
          promise.resolve(mapOf("uri" to "file://${dest.absolutePath}"))
        } catch (e: Exception) {
          promise.reject("ERR_THUMBNAIL", e.message ?: "缩略图生成失败", e)
        }
      }.start()
    }
  }
}
