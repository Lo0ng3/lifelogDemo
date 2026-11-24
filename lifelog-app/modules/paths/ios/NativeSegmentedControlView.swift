import ExpoModulesCore
import UIKit

// 苹果原生 UISegmentedControl 封装：
// - iOS 26+ 自动获得苹果原生液态玻璃滑块与跟手拖拽手势；
// - iOS 15~18 使用系统原生弹簧滑块与触感；
// - 触控完全在 UIKit 主管线响应，彻底消除 JS 侧分段控件的点击延迟。
public final class NativeSegmentedControlView: ExpoView {
  private let segmentedControl = UISegmentedControl()
  private var currentSegments: [String] = []
  private var currentIndex: Int = 0
  private var isUpdatingProgrammatically = false

  let onValueChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear

    segmentedControl.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    segmentedControl.addTarget(self, action: #selector(handleValueChanged(_:)), for: .valueChanged)
    addSubview(segmentedControl)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    segmentedControl.frame = bounds
  }

  public func setSegments(_ segments: [String]) {
    if segments == currentSegments { return }
    currentSegments = segments
    isUpdatingProgrammatically = true
    segmentedControl.removeAllSegments()
    for (idx, title) in segments.enumerated() {
      segmentedControl.insertSegment(withTitle: title, at: idx, animated: false)
    }
    if currentIndex >= 0 && currentIndex < segments.count {
      segmentedControl.selectedSegmentIndex = currentIndex
    } else if !segments.isEmpty {
      currentIndex = 0
      segmentedControl.selectedSegmentIndex = 0
    }
    isUpdatingProgrammatically = false
  }

  public func setSelectedIndex(_ index: Int) {
    currentIndex = index
    guard index >= 0 && index < segmentedControl.numberOfSegments else { return }
    if segmentedControl.selectedSegmentIndex == index { return }
    isUpdatingProgrammatically = true
    segmentedControl.selectedSegmentIndex = index
    isUpdatingProgrammatically = false
  }

  public func setIsDark(_ isDark: Bool) {
    segmentedControl.overrideUserInterfaceStyle = isDark ? .dark : .light
  }

  @objc private func handleValueChanged(_ sender: UISegmentedControl) {
    if isUpdatingProgrammatically { return }
    let idx = sender.selectedSegmentIndex
    guard idx >= 0 else { return }
    currentIndex = idx
    onValueChange(["index": idx])
  }
}
