Pod::Spec.new do |s|
  s.name             = 'Paths'
  s.version          = '1.0.0'
  s.summary          = '原生文件操作与网页缓存清理模块（印记）'
  s.description      = 'Native file helpers (App Group share copies, range reads, WKWebView cache clear) for lifelog-app.'
  s.license          = 'MIT'
  s.author           = 'lifelog-app'
  s.homepage         = 'https://github.com/Lo0ng3/lifelogDemo'
  s.platforms        = { :ios => '15.1' }
  s.swift_version    = '5.4'
  s.source           = { :git => 'https://github.com/Lo0ng3/lifelogDemo.git', :tag => s.version.to_s }
  s.static_framework = true
  s.frameworks       = 'WebKit', 'UIKit'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.swift'
end
