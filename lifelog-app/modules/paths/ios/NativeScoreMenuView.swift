import ExpoModulesCore
import UIKit

// iOS 原生评分下拉菜单按钮（UIButton + UIMenu，iOS 15+ 原生弹出菜单，风格与原生日期胶囊一致）：
// 点击右侧「未评 / 4.5 分」胶囊直接弹出系统原生菜单选择 0.5–5.0 分或取消评分，无需多占一行。
public final class NativeScoreMenuView: ExpoView {
  private let button = UIButton(type: .system)
  private var currentRating: Double = 0
  private var isDarkMode: Bool = false
  private var accentHex: String = "#1D63ED"

  private static let options: [Double] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]

  let onSelect = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = false

    button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    button.showsMenuAsPrimaryAction = true
    button.layer.cornerRadius = 9
    button.clipsToBounds = true
    button.contentHorizontalAlignment = .center
    button.titleLabel?.font = UIFont.monospacedDigitSystemFont(ofSize: 13.5, weight: .semibold)
    addSubview(button)

    refreshUI()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if button.frame != bounds {
      button.frame = bounds
    }
  }

  public func setRating(_ value: Double) {
    if abs(value - currentRating) < 0.001 { return }
    currentRating = value
    refreshUI()
  }

  public func setIsDark(_ isDark: Bool) {
    if isDarkMode == isDark && overrideUserInterfaceStyle != .unspecified {
      return
    }
    isDarkMode = isDark
    let style: UIUserInterfaceStyle = isDark ? .dark : .light
    overrideUserInterfaceStyle = style
    button.overrideUserInterfaceStyle = style
    refreshUI()
  }

  public func setAccentColor(_ hex: String) {
    if accentHex == hex { return }
    accentHex = hex
    refreshUI()
  }

  private func labelFor(_ val: Double) -> String {
    if val <= 0 { return "未评" }
    if abs(val.rounded() - val) < 0.001 {
      return "\(Int(val.rounded())) 分"
    }
    return String(format: "%.1f 分", val)
  }

  private func refreshUI() {
    let title = labelFor(currentRating)
    UIView.performWithoutAnimation {
      button.setTitle(title, for: .normal)
      button.layoutIfNeeded()
    }

    let accent = parseHexColor(accentHex) ?? (isDarkMode
      ? UIColor(red: 0.294, green: 0.545, blue: 1.0, alpha: 1.0)
      : UIColor(red: 0.114, green: 0.388, blue: 0.929, alpha: 1.0))

    if currentRating > 0 {
      button.setTitleColor(accent, for: .normal)
      button.backgroundColor = accent.withAlphaComponent(isDarkMode ? 0.18 : 0.12)
    } else {
      button.setTitleColor(isDarkMode ? UIColor(white: 0.65, alpha: 1) : UIColor(white: 0.45, alpha: 1), for: .normal)
      button.backgroundColor = isDarkMode ? UIColor(white: 1.0, alpha: 0.08) : UIColor(white: 0.0, alpha: 0.06)
    }

    let actions = Self.options.map { val -> UIAction in
      let selected = abs(val - currentRating) < 0.001
      return UIAction(
        title: labelFor(val),
        state: selected ? .on : .off
      ) { [weak self] _ in
        guard let self = self else { return }
        self.currentRating = val
        self.refreshUI()
        self.onSelect(["rating": val])
      }
    }
    button.menu = UIMenu(title: "", children: actions)
  }

  private func parseHexColor(_ raw: String) -> UIColor? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let val = UInt64(s, radix: 16) else { return nil }
    let r = CGFloat((val >> 16) & 0xFF) / 255.0
    let g = CGFloat((val >> 8) & 0xFF) / 255.0
    let b = CGFloat(val & 0xFF) / 255.0
    return UIColor(red: r, green: g, blue: b, alpha: 1.0)
  }
}
