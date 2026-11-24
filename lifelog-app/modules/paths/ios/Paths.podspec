Pod::Spec.new do |s|
  s.name           = 'expo-modules-paths'
  s.version        = '1.0.0'
  s.summary        = '原生文件操作与网页缓存清理模块（印记）'
  s.description    = 'Native file helpers (App Group share copies, range reads, WKWebView cache clear) for lifelog-app.'
  s.author         = ''
  s.homepage       = ''
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
