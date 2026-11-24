import CoreLocation
import ImageIO
import Photos
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// iOS 原生相册选图器（PHPickerViewController）：
// 1. 使用 PHPickerConfiguration(photoLibrary: .shared()) 拿到 PHAsset.localIdentifier，
//    直接读取 PhotoKit 元数据（尺寸、文件名、字节数、实况标记、GPS），全程零文件复制；
// 2. 若用户拒绝相册权限或选了“受限相册”外的照片，自动兜底通过 NSItemProvider 拷贝到 Documents/media/，
//    确保任何权限状态下都能正常选图。
final class NativePhotoPickerCoordinator: NSObject, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  private let lock = NSLock()
  private var completion: (([String: Any]) -> Void)?
  private var finished = false

  func present(selectionLimit: Int = 0, completion: @escaping ([String: Any]) -> Void) {
    self.completion = completion
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    if status == .notDetermined {
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
        DispatchQueue.main.async {
          self.presentPickerOnMain(selectionLimit: selectionLimit)
        }
      }
    } else {
      DispatchQueue.main.async {
        self.presentPickerOnMain(selectionLimit: selectionLimit)
      }
    }
  }

  private func presentPickerOnMain(selectionLimit: Int) {
    guard let presenter = Self.topViewController() else {
      finish(with: ["canceled": true, "assets": []])
      return
    }

    var config = PHPickerConfiguration(photoLibrary: .shared())
    config.selectionLimit = max(0, selectionLimit)
    config.filter = .any(of: [.images, .videos])
    config.preferredAssetRepresentationMode = .current
    if #available(iOS 15.0, *) {
      config.selection = .ordered
    }

    let picker = PHPickerViewController(configuration: config)
    picker.delegate = self
    picker.presentationController?.delegate = self
    presenter.present(picker, animated: true)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish(with: ["canceled": true, "assets": []])
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)

    if results.isEmpty {
      finish(with: ["canceled": true, "assets": []])
      return
    }

    DispatchQueue.global(qos: .userInitiated).async {
      let group = DispatchGroup()
      let resultLock = NSLock()
      var resolved: [[String: Any]?] = Array(repeating: nil, count: results.count)
      var locations: [[String: Double]?] = Array(repeating: nil, count: results.count)

      for (index, result) in results.enumerated() {
        // 优先零复制路径：拿到 assetIdentifier 且 PhotoKit 可读时，只存 ph:// 引用与元数据
        if let assetId = result.assetIdentifier,
           !assetId.isEmpty,
           let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject {
          let (entry, loc) = self.buildZeroCopyEntry(from: asset)
          resultLock.lock()
          resolved[index] = entry
          locations[index] = loc
          resultLock.unlock()
          continue
        }

        // 兜底路径：未授相册权限或所选照片不在 Limited 授权范围内时，通过 ItemProvider 落地到 Documents/media/
        group.enter()
        self.copyFallbackEntry(from: result.itemProvider) { entry in
          if let entry = entry {
            resultLock.lock()
            resolved[index] = entry
            resultLock.unlock()
          }
          group.leave()
        }
      }

      group.notify(queue: .main) {
        let assets = resolved.compactMap { $0 }
        let firstLocation = locations.compactMap { $0 }.first
        var payload: [String: Any] = [
          "canceled": assets.isEmpty,
          "assets": assets,
        ]
        if let loc = firstLocation {
          payload["location"] = loc
        }
        self.finish(with: payload)
      }
    }
  }

  private func buildZeroCopyEntry(from asset: PHAsset) -> ([String: Any], [String: Double]?) {
    let isVideo = asset.mediaType == .video
    let w = asset.pixelWidth
    let h = asset.pixelHeight
    let resources = PHAssetResource.assetResources(for: asset)
    let preferredTypes: [PHAssetResourceType] = isVideo
      ? [.fullSizeVideo, .video]
      : [.fullSizePhoto, .photo]

    var filename: String?
    var fileSize: Double?

    for preferred in preferredTypes {
      if let res = resources.first(where: { $0.type == preferred }) {
        if filename == nil && !res.originalFilename.isEmpty {
          filename = res.originalFilename
        }
        if fileSize == nil,
           let size = (res.value(forKey: "fileSize") as? NSNumber)?.doubleValue,
           size > 0 {
          fileSize = size
        }
      }
    }
    if filename == nil {
      filename = resources.first(where: { !$0.originalFilename.isEmpty })?.originalFilename
    }
    if fileSize == nil {
      for res in resources {
        if let size = (res.value(forKey: "fileSize") as? NSNumber)?.doubleValue, size > 0 {
          fileSize = size
          break
        }
      }
    }

    var entry: [String: Any] = [
      "assetId": asset.localIdentifier,
      "uri": "ph://\(asset.localIdentifier)",
      "isVideo": isVideo,
    ]
    if w > 0 && h > 0 {
      entry["ratio"] = Double(w) / Double(h)
      entry["w"] = w
      entry["h"] = h
    }
    if let filename = filename, !filename.isEmpty {
      entry["filename"] = filename
    }
    if let fileSize = fileSize, fileSize > 0 {
      entry["size"] = fileSize
    }
    if !isVideo {
      let isLive = asset.mediaSubtypes.contains(.photoLive)
      entry["mediaSubtypes"] = isLive ? ["livePhoto"] : []
      entry["liveStatus"] = isLive ? "live" : "not-live"
      entry["liveSource"] = "ios"
    }

    var location: [String: Double]?
    if let coord = asset.location?.coordinate,
       CLLocationCoordinate2DIsValid(coord),
       !(coord.latitude == 0 && coord.longitude == 0) {
      location = [
        "latitude": coord.latitude,
        "longitude": coord.longitude,
      ]
    }
    return (entry, location)
  }

  private func copyFallbackEntry(from provider: NSItemProvider, done: @escaping ([String: Any]?) -> Void) {
    let isVideo = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
    let typeId = isVideo ? UTType.movie.identifier : UTType.image.identifier
    guard provider.hasItemConformingToTypeIdentifier(typeId) else {
      done(nil)
      return
    }

    provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, _ in
      guard let url = url else {
        done(nil)
        return
      }
      let fm = FileManager.default
      let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
      let mediaDir = docs.appendingPathComponent("media", isDirectory: true)
      try? fm.createDirectory(at: mediaDir, withIntermediateDirectories: true)

      let rawExt = url.pathExtension.lowercased()
      let ext = rawExt.isEmpty ? (isVideo ? "mov" : "jpg") : rawExt
      let stamp = Int(Date().timeIntervalSince1970 * 1000)
      let token = String(UUID().uuidString.prefix(8)).lowercased()
      let dest = mediaDir.appendingPathComponent("pick_\(stamp)_\(token).\(ext)")

      do {
        if fm.fileExists(atPath: dest.path) {
          try fm.removeItem(at: dest)
        }
        try fm.copyItem(at: url, to: dest)
      } catch {
        done(nil)
        return
      }

      var entry: [String: Any] = [
        "uri": dest.absoluteString,
        "isVideo": isVideo,
      ]
      if let suggested = provider.suggestedName, !suggested.isEmpty {
        let hasExt = !(suggested as NSString).pathExtension.isEmpty
        entry["filename"] = hasExt ? suggested : "\(suggested).\(ext)"
      } else {
        entry["filename"] = url.lastPathComponent
      }
      if let attrs = try? fm.attributesOfItem(atPath: dest.path),
         let size = (attrs[.size] as? NSNumber)?.doubleValue,
         size > 0 {
        entry["size"] = size
      }
      if !isVideo, let dims = Self.imageDimensions(at: dest) {
        entry["w"] = dims.width
        entry["h"] = dims.height
        if dims.height > 0 {
          entry["ratio"] = Double(dims.width) / Double(dims.height)
        }
      }
      done(entry)
    }
  }

  private static func imageDimensions(at url: URL) -> (width: Int, height: Int)? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
          let w = props[kCGImagePropertyPixelWidth] as? Int,
          let h = props[kCGImagePropertyPixelHeight] as? Int,
          w > 0, h > 0 else {
      return nil
    }
    let orientation = (props[kCGImagePropertyOrientation] as? Int) ?? 1
    if orientation >= 5 && orientation <= 8 {
      return (h, w)
    }
    return (w, h)
  }

  private func finish(with payload: [String: Any]) {
    lock.lock()
    if finished {
      lock.unlock()
      return
    }
    finished = true
    let cb = completion
    completion = nil
    lock.unlock()

    if Thread.isMainThread {
      cb?(payload)
    } else {
      DispatchQueue.main.async {
        cb?(payload)
      }
    }
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let activeScene = scenes.first(where: { $0.activationState == .foregroundActive })
      ?? scenes.first(where: { $0.activationState == .foregroundInactive })
      ?? scenes.first
    let window = activeScene?.windows.first(where: { $0.isKeyWindow })
      ?? activeScene?.windows.first
    guard var top = window?.rootViewController else { return nil }
    while let next = top.presentedViewController, !next.isBeingDismissed {
      top = next
    }
    return top
  }
}
