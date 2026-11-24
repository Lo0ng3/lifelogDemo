import ExpoModulesCore
import UIKit

// 苹果原生液态玻璃背景视图：
// - iOS 26+：运行时动态创建苹果原生 UIGlassEffect（真·液态玻璃折射/高光/交互透镜），
//   即使在 Xcode 16（iOS 18 SDK）云端构建机上也能零报错编译，装到 iOS 26 真机自动生效；
// - iOS 15~18：原生 UIBlurEffect(.systemChromeMaterialLight / Dark) + 连续圆角高光描边，
//   走系统 GPU 合成（摒弃 expo-blur 的 UIViewPropertyAnimator 动画卡顿问题）。
public final class LiquidGlassView: ExpoView {
  private let effectView = UIVisualEffectView(effect: nil)
  private var cornerRadiusValue: CGFloat = 28
  private var darkMode: Bool = false
  private var interactiveMode: Bool = true
  private var usingNativeGlass: Bool = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    isUserInteractionEnabled = false

    effectView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    effectView.isUserInteractionEnabled = false
    effectView.clipsToBounds = true
    effectView.layer.cornerCurve = .continuous
    addSubview(effectView)

    applyAppearance()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    effectView.frame = bounds
    let maxRadius = min(bounds.width, bounds.height) / 2
    effectView.layer.cornerRadius = maxRadius > 0 ? min(cornerRadiusValue, maxRadius) : cornerRadiusValue
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

  private func applyAppearance() {
    effectView.overrideUserInterfaceStyle = darkMode ? .dark : .light

    // iOS 26+ 原生 UIGlassEffect（运行时动态加载，兼容旧版 Xcode SDK 编译）
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
        return
      }
    }

    // iOS 15~18 降级：系统原生材质模糊 + 液态玻璃高光边缘
    usingNativeGlass = false
    let blurStyle: UIBlurEffect.Style = darkMode ? .systemChromeMaterialDark : .systemChromeMaterialLight
    effectView.effect = UIBlurEffect(style: blurStyle)
    effectView.contentView.backgroundColor = darkMode
      ? UIColor(white: 1.0, alpha: 0.05)
      : UIColor(white: 1.0, alpha: 0.22)
    effectView.layer.borderWidth = 0.75
    effectView.layer.borderColor = darkMode
      ? UIColor(white: 1.0, alpha: 0.22).cgColor
      : UIColor(white: 1.0, alpha: 0.65).cgColor
  }
}
