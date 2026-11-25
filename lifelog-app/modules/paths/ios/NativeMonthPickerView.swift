import ExpoModulesCore
import UIKit

// iOS 原生年月双滚轮选择器（UIPickerView）：
// 左列为年份（minYear...maxYear），右列为 1月...12月；自动适配系统深浅色与触觉滚轮反馈。
public final class NativeMonthPickerView: ExpoView, UIPickerViewDataSource, UIPickerViewDelegate {
  private let pickerView = UIPickerView()
  private var minYear: Int = 2000
  private var maxYear: Int = 2035
  private var selectedYear: Int = Calendar.current.component(.year, from: Date())
  private var selectedMonth: Int = Calendar.current.component(.month, from: Date())
  private var isDarkMode: Bool = false

  let onChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    pickerView.dataSource = self
    pickerView.delegate = self
    pickerView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(pickerView)
    syncSelection(animated: false)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if pickerView.frame != bounds {
      pickerView.frame = bounds
    }
  }

  public func setMinYear(_ value: Int) {
    let clamped = max(1970, min(value, maxYear))
    if clamped == minYear { return }
    minYear = clamped
    pickerView.reloadComponent(0)
    syncSelection(animated: false)
  }

  public func setMaxYear(_ value: Int) {
    let clamped = max(minYear, min(value, 2100))
    if clamped == maxYear { return }
    maxYear = clamped
    pickerView.reloadComponent(0)
    syncSelection(animated: false)
  }

  public func setYear(_ value: Int) {
    let clamped = max(minYear, min(value, maxYear))
    if clamped == selectedYear { return }
    selectedYear = clamped
    syncSelection(animated: false)
  }

  public func setMonth(_ value: Int) {
    let clamped = max(1, min(value, 12))
    if clamped == selectedMonth { return }
    selectedMonth = clamped
    syncSelection(animated: false)
  }

  public func setIsDark(_ isDark: Bool) {
    if isDarkMode == isDark && pickerView.overrideUserInterfaceStyle != .unspecified {
      return
    }
    isDarkMode = isDark
    let style: UIUserInterfaceStyle = isDark ? .dark : .light
    overrideUserInterfaceStyle = style
    pickerView.overrideUserInterfaceStyle = style
    pickerView.reloadAllComponents()
    syncSelection(animated: false)
  }

  private func syncSelection(animated: Bool) {
    let yearCount = max(1, maxYear - minYear + 1)
    let yearRow = max(0, min(yearCount - 1, selectedYear - minYear))
    let monthRow = max(0, min(11, selectedMonth - 1))
    if pickerView.selectedRow(inComponent: 0) != yearRow {
      pickerView.selectRow(yearRow, inComponent: 0, animated: animated)
    }
    if pickerView.selectedRow(inComponent: 1) != monthRow {
      pickerView.selectRow(monthRow, inComponent: 1, animated: animated)
    }
  }

  public func numberOfComponents(in pickerView: UIPickerView) -> Int {
    return 2
  }

  public func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
    return component == 0 ? max(1, maxYear - minYear + 1) : 12
  }

  public func pickerView(_ pickerView: UIPickerView, rowHeightForComponent component: Int) -> CGFloat {
    return 38.0
  }

  public func pickerView(_ pickerView: UIPickerView, attributedTitleForRow row: Int, forComponent component: Int) -> NSAttributedString? {
    let text = component == 0 ? "\(minYear + row)年" : "\(row + 1)月"
    let color: UIColor = isDarkMode ? .white : UIColor(red: 0.1, green: 0.11, blue: 0.14, alpha: 1.0)
    return NSAttributedString(
      string: text,
      attributes: [
        .foregroundColor: color,
        .font: UIFont.systemFont(ofSize: 19, weight: .regular),
      ]
    )
  }

  public func pickerView(_ pickerView: UIPickerView, didSelectRow row: Int, inComponent component: Int) {
    if component == 0 {
      selectedYear = minYear + row
    } else {
      selectedMonth = row + 1
    }
    onChange([
      "year": selectedYear,
      "month": selectedMonth,
    ])
  }
}
