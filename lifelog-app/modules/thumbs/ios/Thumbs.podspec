Pod::Spec.new do |s|
  s.name             = 'Thumbs'
  s.version          = '1.0.0'
  s.summary          = '系统微缩略图管道（印记选图器）'
  s.description      = 'PHImageManager-based system thumbnail pipeline for the media picker.'
  s.license          = 'MIT'
  s.author           = 'lifelog-app'
  s.homepage         = 'https://github.com/Lo0ng3/lifelogDemo'
  s.platforms        = { :ios => '15.1' }
  s.swift_version    = '5.4'
  s.source           = { :git => 'https://github.com/Lo0ng3/lifelogDemo.git', :tag => s.version.to_s }
  s.static_framework = true
  s.frameworks       = 'Photos', 'UIKit'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.swift'
end
