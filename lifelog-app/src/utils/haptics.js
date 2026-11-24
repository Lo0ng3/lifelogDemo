import { Platform } from 'react-native';

let Haptics = null;
try {
  Haptics = require('expo-haptics');
} catch {}

// 统一触感反馈：iOS 上提供细腻的原生 Taptic Engine 触感，模块缺失时静默跳过
export function hapticSelection() {
  if (Platform.OS !== 'ios') return;
  try { Haptics?.selectionAsync?.(); } catch {}
}

export function hapticLight() {
  try { Haptics?.impactAsync?.(Haptics.ImpactFeedbackStyle.Light); } catch {}
}

export function hapticMedium() {
  if (Platform.OS !== 'ios') return;
  try { Haptics?.impactAsync?.(Haptics.ImpactFeedbackStyle.Medium); } catch {}
}

export function hapticSuccess() {
  if (Platform.OS !== 'ios') return;
  try { Haptics?.notificationAsync?.(Haptics.NotificationFeedbackType.Success); } catch {}
}

export function hapticWarning() {
  if (Platform.OS !== 'ios') return;
  try { Haptics?.notificationAsync?.(Haptics.NotificationFeedbackType.Warning); } catch {}
}
