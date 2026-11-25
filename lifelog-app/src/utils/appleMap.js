import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

const NativePaths = Platform.OS === 'ios' ? requireOptionalNativeModule('Paths') : null;

export const hasAppleMapSearch =
  Platform.OS === 'ios' &&
  typeof NativePaths?.searchApplePlaces === 'function' &&
  typeof NativePaths?.geocodeApplePlace === 'function';

export async function searchApplePlacesAsync(query) {
  if (!hasAppleMapSearch) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const res = await NativePaths.searchApplePlaces(q);
    return Array.isArray(res) ? res : [];
  } catch {
    return [];
  }
}

export async function geocodeApplePlaceAsync(query) {
  if (!hasAppleMapSearch) return null;
  const q = String(query || '').trim();
  if (!q) return null;
  try {
    const res = await NativePaths.geocodeApplePlace(q);
    if (!res || typeof res !== 'object') return null;
    const lat = Number(res.lat);
    const lng = Number(res.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}
