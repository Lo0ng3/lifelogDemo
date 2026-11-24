import ExpoModulesCore
import UIKit

// 苹果真·原生液态玻璃背景视图：
// - iOS 26+（Xcode 26 SDK 编译）：直接使用苹果官方 UIGlassEffect(style: .regular) + UICornerConfiguration，
//   完全遵循系统「设置 → 显示与亮度 → 液态玻璃（透明 / 色调）」与「降低透明度」设置，
//   不做 clipsToBounds 裁切、不叠不透明底色，完整保留原生通透折射与高光边缘；
// - 旧版 Xcode 编译在 iOS 26 运行时：通过运行时动态加载 UIGlassEffect 兜底；
// - iOS 15~18 降级：系统原生 systemUltraThinMaterial 通透毛玻璃。
public final class LiquidGlassView: ExpoView {
  private let effectView = UIVisualEffectView(effect: nil)
  private var cornerRadiusValue: CGFloat = 28
  private var darkMode: Bool = false
  private var interactiveMode: Bool = true
  private var usingNativeGlass: Bool = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = false
    isUserInteractionEnabled = false

    effectView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    effectView.isUserInteractionEnabled = false
    effectView.backgroundColor = .clear
    addSubview(effectView)

    applyAppearance()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    effectView.frame = bounds
    applyCorners()
  }

  public func setCornerRadius(_ value: Double) {
    cornerRadiusValue = CGFloat(max(0, value))
    setNeedsLayout()
  }

  public func setIsDark(_ value: Bool) {
    if darkMode == value && effectView.effect != nil { return }
    darkMode = value
    applyAppearance()
  }

  public func setInteractive(_ value: Bool) {
    if interactiveMode == value && effectView.effect != nil { return }
    interactiveMode = value
    applyAppearance()
  }

  private func applyCorners() {
    let halfMin = min(bounds.width, bounds.height) / 2
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), usingNativeGlass {
      if halfMin > 0 && cornerRadiusValue >= halfMin - 1 {
        effectView.cornerConfiguration = .capsule()
      } else {
        effectView.cornerConfiguration = .corners(radius: .fixed(cornerRadiusValue))
      }
      return
    }
    #endif

    effectView.clipsToBounds = true
    effectView.layer.cornerCurve = .continuous
    effectView.layer.cornerRadius = halfMin > 0 ? min(cornerRadiusValue, halfMin) : cornerRadiusValue
  }

  private func applyAppearance() {
    effectView.overrideUserInterfaceStyle = darkMode ? .dark : .light

    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      // .regular 是苹果官方标准液态玻璃样式：系统选择「透明」时通透清亮，选择「色调」或「降低透明度」时自动加深
      let glass = UIGlassEffect(style: .regular)
      glass.isInteractive = interactiveMode
      glass.tintColor = nil
      usingNativeGlass = true
      effectView.effect = glass
      effectView.clipsToBounds = false
      effectView.contentView.backgroundColor = .clear
      effectView.layer.borderWidth = 0
      effectView.layer.borderColor = nil
      applyCorners()
      return
    }
    #endif

    // 旧版 SDK 编译时的运行时动态兜底（iOS 26 真机）
    if let glassClass = NSClassFromString("UIGlassEffect") as? NSObject.Type {
      let glassObj = glassClass.init()
      let setInteractiveSel = NSSelectorFromString("setInteractive:")
      if glassObj.responds(to: setInteractiveSel) {
        typealias SetBoolIMP = @convention(c) (AnyObject, Selector, Bool) -> Void
        let imp = glassObj.method(for: setInteractiveSel)
        let fn = unsafeBitCast(imp, to: SetBoolIMP.self)
        fn(glassObj, setInteractiveSel, interactiveMode)
      }
      if let visualEffect = glassObj as? UIVisualEffect {
        usingNativeGlass = true
        effectView.effect = visualEffect
        effectView.contentView.backgroundColor = .clear
        effectView.layer.borderWidth = 0
        effectView.layer.borderColor = nil
        applyCorners()
        return
      }
    }

    // iOS 15~18 降级：系统超薄通透毛玻璃
    usingNativeGlass = false
    let blurStyle: UIBlurEffect.Style = darkMode ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight
    effectView.effect = UIBlurEffect(style: blurStyle)
    effectView.contentView.backgroundColor = .clear
    effectView.layer.borderWidth = 0.5
    effectView.layer.borderColor = darkMode
      ? UIColor(white: 1.0, alpha: 0.18).cgColor
      : UIColor(white: 1.0, alpha: 0.55).cgColor
    applyCorners()
  }
}
