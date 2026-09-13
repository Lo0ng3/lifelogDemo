import ExpoModulesCore
import Photos
import UIKit

// 系统微缩略图管道：PHImageManager.requestImage 是系统相册/选择器同款的封面来源，
// 照片与视频都能出帧，结果落盘缓存目录后以 file:// 返回，重复请求零开销
public class ThumbsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Thumbs")

    AsyncFunction("getThumbnailAsync") { (assetId: String, isVideo: Bool, size: Double, promise: Promise) in
      let px = min(max(Int(size), 64), 1024)
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      let dir = caches.appendingPathComponent("thumbs", isDirectory: true)
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let kind = isVideo ? "v" : "i"
      let dest = dir.appendingPathComponent("thumb_\(kind)_\(assetId)_\(px).jpg")

      if FileManager.default.fileExists(atPath: dest.path) {
        promise.resolve(["uri": dest.absoluteString])
        return
      }

      guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
        promise.reject("ERR_NOT_FOUND", "照片不存在或未被授权访问")
        return
      }

      let options = PHImageRequestOptions()
      options.deliveryMode = .highQualityFormat
      options.resizeMode = .fast
      options.isNetworkAccessAllowed = true   // iCloud 图库：允许联网拉取封面
      options.version = .current

      var settled = false
      PHImageManager.default().requestImage(
        for: asset,
        targetSize: CGSize(width: px, height: px),
        contentMode: .aspectFill,
        options: options
      ) { image, info in
        // opportunistic 模式下可能回调多次，只认第一次成功结果
        guard !settled, let image = image, let data = image.jpegData(compressionQuality: 0.85) else { return }
        settled = true
        do {
          try data.write(to: dest)
          promise.resolve(["uri": dest.absoluteString])
        } catch {
          promise.reject("ERR_WRITE", error.localizedDescription)
        }
      }
    }
  }
}
