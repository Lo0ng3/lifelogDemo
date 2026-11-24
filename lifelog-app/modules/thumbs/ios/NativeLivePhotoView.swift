import AVFoundation
import ExpoModulesCore
import Photos
import PhotosUI
import UIKit

// 苹果原生 PHLivePhotoView 封装：
// - 直接从 PhotoKit 加载 PHLivePhoto，零临时文件拷贝；
// - 原生支持系统级长按任意位置播放实况，也支持通过 playTrigger 单击触发完整实况播放；
// - 自动配置 AVAudioSession(.playback)，静音开关打开时也能正常出声。
public final class NativeLivePhotoView: ExpoView, PHLivePhotoViewDelegate {
  private let livePhotoView = PHLivePhotoView()
  private var currentAssetId: String = ""
  private var isActive: Bool = true
  private var lastPlayTrigger: Int = 0
  private var pendingPlay: Bool = false
  private var requestId: PHImageRequestID = PHInvalidImageRequestID
  private var isPlaying: Bool = false

  let onPlaybackChange = EventDispatcher()
  let onLoadState = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = true

    livePhotoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    livePhotoView.contentMode = .scaleAspectFit
    livePhotoView.isMuted = false
    livePhotoView.delegate = self
    addSubview(livePhotoView)

    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
    tap.cancelsTouchesInView = false
    livePhotoView.addGestureRecognizer(tap)
  }

  @objc private func handleTap() {
    guard isActive, livePhotoView.livePhoto != nil else { return }
    if isPlaying {
      livePhotoView.stopPlayback()
    } else {
      startFullPlayback()
    }
  }

  deinit {
    cancelRequest()
    livePhotoView.stopPlayback()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    livePhotoView.frame = bounds
  }

  public func setAssetId(_ assetId: String) {
    let cleaned = assetId.trimmingCharacters(in: .whitespacesAndNewlines)
    if cleaned == currentAssetId { return }
    currentAssetId = cleaned
    pendingPlay = false
    cancelRequest()
    livePhotoView.stopPlayback()
    livePhotoView.livePhoto = nil
    loadLivePhoto()
  }

  public func setActive(_ active: Bool) {
    isActive = active
    if !active {
      pendingPlay = false
      livePhotoView.stopPlayback()
    }
  }

  public func setPlayTrigger(_ trigger: Int) {
    if trigger == lastPlayTrigger { return }
    lastPlayTrigger = trigger
    guard trigger > 0, isActive else { return }
    if livePhotoView.livePhoto != nil {
      startFullPlayback()
    } else {
      pendingPlay = true
      if requestId == PHInvalidImageRequestID {
        loadLivePhoto()
      }
    }
  }

  private func loadLivePhoto() {
    guard !currentAssetId.isEmpty else { return }
    let stripped = currentAssetId.hasPrefix("ph://")
      ? String(currentAssetId.dropFirst(5))
      : currentAssetId
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [stripped], options: nil).firstObject else {
      onLoadState(["loaded": false, "error": true])
      return
    }

    let scale = UIScreen.main.scale
    let screenBounds = UIScreen.main.bounds
    let targetSize = CGSize(
      width: min(max(screenBounds.width * scale, 1080), 2400),
      height: min(max(screenBounds.height * scale, 1080), 2400)
    )

    let opts = PHLivePhotoRequestOptions()
    opts.deliveryMode = .highQualityFormat
    opts.isNetworkAccessAllowed = true
    opts.version = .current

    let requestedId = currentAssetId
    requestId = PHImageManager.default().requestLivePhoto(
      for: asset,
      targetSize: targetSize,
      contentMode: .aspectFit,
      options: opts
    ) { [weak self] livePhoto, info in
      DispatchQueue.main.async {
        guard let self = self, self.currentAssetId == requestedId else { return }
        let isDegraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
        if let photo = livePhoto {
          self.livePhotoView.livePhoto = photo
          if !isDegraded {
            self.requestId = PHInvalidImageRequestID
            self.onLoadState(["loaded": true, "error": false])
            if self.pendingPlay && self.isActive {
              self.pendingPlay = false
              self.startFullPlayback()
            }
          }
        } else if !isDegraded {
          self.requestId = PHInvalidImageRequestID
          self.pendingPlay = false
          self.onLoadState(["loaded": false, "error": true])
        }
      }
    }
  }

  private func startFullPlayback() {
    configureAudioSession()
    livePhotoView.isMuted = false
    if isPlaying {
      livePhotoView.stopPlayback()
    }
    livePhotoView.startPlayback(with: .full)
  }

  private func configureAudioSession() {
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      try session.setActive(true)
    } catch {}
  }

  private func cancelRequest() {
    if requestId != PHInvalidImageRequestID {
      PHImageManager.default().cancelImageRequest(requestId)
      requestId = PHInvalidImageRequestID
    }
  }

  // MARK: - PHLivePhotoViewDelegate

  public func livePhotoView(
    _ livePhotoView: PHLivePhotoView,
    willBeginPlaybackWith playbackStyle: PHLivePhotoViewPlaybackStyle
  ) {
    configureAudioSession()
    isPlaying = true
    onPlaybackChange(["playing": true])
  }

  public func livePhotoView(
    _ livePhotoView: PHLivePhotoView,
    didEndPlaybackWith playbackStyle: PHLivePhotoViewPlaybackStyle
  ) {
    isPlaying = false
    onPlaybackChange(["playing": false])
  }
}
