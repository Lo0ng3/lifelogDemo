import ExpoModulesCore
import UIKit

// iOS 原生年月弹出选择器（与系统紧凑日期选择器一致的锚定式 UIPopoverPresentationController）：
// 本身渲染为「2026年11月 ⌄」按钮，点击后直接在按钮正下方弹出原生悬浮气泡（内含年/月双滚轮），
// 滑动即实时同步月份，点气泡外部自动收起，不再从屏幕底部弹黑底抽屉。
private final class MonthWheelPopoverController: UIViewController, UIPickerViewDataSource, UIPickerViewDelegate {
  private let pickerView = UIPickerView()
  private let minYear: Int
  private let maxYear: Int
  private var selectedYear: Int
  private var selectedMonth: Int
  private let isDarkMode: Bool
  private let onSelect: (Int, Int) -> Void

  init(minYear: Int, maxYear: Int, year: Int, month: Int, isDark: Bool, onSelect: @escaping (Int, Int) -> Void) {
    self.minYear = minYear
    self.maxYear = maxYear
    self.selectedYear = max(minYear, min(year, maxYear))
    self.selectedMonth = max(1, min(month, 12))
    self.isDarkMode = isDark
    self.onSelect = onSelect
    super.init(nibName: nil, bundle: nil)
    preferredContentSize = CGSize(width: 244, height: 196)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    let style: UIUserInterfaceStyle = isDarkMode ? .dark : .light
    overrideUserInterfaceStyle = style
    view.backgroundColor = .clear

    pickerView.overrideUserInterfaceStyle = style
    pickerView.dataSource = self
    pickerView.delegate = self
    pickerView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(pickerView)

    NSLayoutConstraint.activate([
      pickerView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 4),
      pickerView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -4),
      pickerView.topAnchor.constraint(equalTo: view.topAnchor, constant: 2),
      pickerView.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -2),
    ])

    let yearRow = max(0, min(maxYear - minYear, selectedYear - minYear))
    let monthRow = max(0, min(11, selectedMonth - 1))
    pickerView.selectRow(yearRow, inComponent: 0, animated: false)
    pickerView.selectRow(monthRow, inComponent: 1, animated: false)
  }

  func numberOfComponents(in pickerView: UIPickerView) -> Int {
    return 2
  }

  func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
    return component == 0 ? max(1, maxYear - minYear + 1) : 12
  }

  func pickerView(_ pickerView: UIPickerView, rowHeightForComponent component: Int) -> CGFloat {
    return 36.0
  }

  func pickerView(_ pickerView: UIPickerView, attributedTitleForRow row: Int, forComponent component: Int) -> NSAttributedString? {
    let text = component == 0 ? "\(minYear + row)年" : "\(row + 1)月"
    let color: UIColor = isDarkMode ? .white : UIColor(red: 0.1, green: 0.11, blue: 0.14, alpha: 1.0)
    return NSAttributedString(
      string: text,
      attributes: [
        .foregroundColor: color,
        .font: UIFont.systemFont(ofSize: 18, weight: .regular),
      ]
    )
  }

  func pickerView(_ pickerView: UIPickerView, didSelectRow row: Int, inComponent component: Int) {
    if component == 0 {
      selectedYear = minYear + row
    } else {
      selectedMonth = row + 1
    }
    onSelect(selectedYear, selectedMonth)
  }
}

public final class NativeMonthPickerView: ExpoView, UIPopoverPresentationControllerDelegate {
  private let button = UIButton(type: .system)
  private var minYear: Int = 2000
  private var maxYear: Int = 2035
  private var selectedYear: Int = Calendar.current.component(.year, from: Date())
  private var selectedMonth: Int = Calendar.current.component(.month, from: Date())
  private var isDarkMode: Bool = false
  private weak var presentedPopover: UIViewController?

  let onChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = false

    button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    button.contentHorizontalAlignment = .leading
    button.semanticContentAttribute = .forceRightToLeft
    button.addTarget(self, action: #selector(handleTap), for: .touchUpInside)
    addSubview(button)
    refreshTitle()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if button.frame != bounds {
      button.frame = bounds
    }
  }

  public func setMinYear(_ value: Int) {
    minYear = max(1970, min(value, maxYear))
  }

  public func setMaxYear(_ value: Int) {
    maxYear = max(minYear, min(value, 2100))
  }

  public func setYear(_ value: Int) {
    let clamped = max(minYear, min(value, maxYear))
    if clamped == selectedYear { return }
    selectedYear = clamped
    refreshTitle()
  }

  public func setMonth(_ value: Int) {
    let clamped = max(1, min(value, 12))
    if clamped == selectedMonth { return }
    selectedMonth = clamped
    refreshTitle()
  }

  public func setIsDark(_ isDark: Bool) {
    if isDarkMode == isDark && overrideUserInterfaceStyle != .unspecified {
      return
    }
    isDarkMode = isDark
    let style: UIUserInterfaceStyle = isDark ? .dark : .light
    overrideUserInterfaceStyle = style
    button.overrideUserInterfaceStyle = style
    refreshTitle()
  }

  private func refreshTitle() {
    let textColor: UIColor = isDarkMode
      ? UIColor(red: 0.945, green: 0.957, blue: 0.976, alpha: 1.0)
      : UIColor(red: 0.102, green: 0.114, blue: 0.137, alpha: 1.0)
    let chevronColor: UIColor = isDarkMode
      ? UIColor(white: 0.62, alpha: 1.0)
      : UIColor(white: 0.52, alpha: 1.0)

    let title = "\(selectedYear)年\(selectedMonth)月 "
    let cfg = UIImage.SymbolConfiguration(pointSize: 11.5, weight: .semibold)
    let chevron = UIImage(systemName: "chevron.down", withConfiguration: cfg)?
      .withTintColor(chevronColor, renderingMode: .alwaysOriginal)

    UIView.performWithoutAnimation {
      button.setTitle(title, for: .normal)
      button.setTitleColor(textColor, for: .normal)
      button.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
      button.setImage(chevron, for: .normal)
      button.layoutIfNeeded()
    }
  }

  @objc private func handleTap() {
    if let existing = presentedPopover, existing.presentingViewController != nil {
      existing.dismiss(animated: true)
      return
    }
    guard let hostVC = findHostViewController() else { return }

    let popVC = MonthWheelPopoverController(
      minYear: minYear,
      maxYear: maxYear,
      year: selectedYear,
      month: selectedMonth,
      isDark: isDarkMode
    ) { [weak self] y, m in
      guard let self = self else { return }
      self.selectedYear = y
      self.selectedMonth = m
      self.refreshTitle()
      self.onChange(["year": y, "month": m])
    }
    popVC.modalPresentationStyle = .popover
    if let pop = popVC.popoverPresentationController {
      pop.delegate = self
      pop.sourceView = button
      pop.sourceRect = CGRect(x: button.bounds.minX, y: button.bounds.minY, width: min(button.bounds.width, 130), height: button.bounds.height)
      pop.permittedArrowDirections = [.up, .down]
    }
    presentedPopover = popVC
    hostVC.present(popVC, animated: true)
  }

  private func findHostViewController() -> UIViewController? {
    var responder: UIResponder? = self
    while let next = responder?.next {
      if let vc = next as? UIViewController {
        var top = vc
        while let child = top.presentedViewController {
          top = child
        }
        return top
      }
      responder = next
    }
    guard let root = window?.rootViewController else { return nil }
    var top = root
    while let child = top.presentedViewController {
      top = child
    }
    return top
  }

  public func adaptivePresentationStyle(for controller: UIPresentationController) -> UIModalPresentationStyle {
    return .none
  }

  public func adaptivePresentationStyle(for controller: UIPresentationController, traitCollection: UITraitCollection) -> UIModalPresentationStyle {
    return .none
  }
}
