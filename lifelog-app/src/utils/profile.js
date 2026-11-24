import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { rebaseAppFileUri } from './storagePaths';

export const PROFILE_NAME_KEY = '@profile_name';
export const PROFILE_AVATAR_KEY = '@profile_avatar';
export const DEFAULT_PROFILE_NAME = '印记';

export const loadProfile = async () => {
  try {
    const [storedName, storedAvatar] = await Promise.all([
      AsyncStorage.getItem(PROFILE_NAME_KEY),
      AsyncStorage.getItem(PROFILE_AVATAR_KEY),
    ]);
    const avatarUri = storedAvatar ? rebaseAppFileUri(storedAvatar) : null;
    if (avatarUri && avatarUri !== storedAvatar) {
      AsyncStorage.setItem(PROFILE_AVATAR_KEY, avatarUri).catch(() => {});
    }
    return {
      name: (storedName || '').trim() || DEFAULT_PROFILE_NAME,
      avatarUri,
    };
  } catch {
    return { name: DEFAULT_PROFILE_NAME, avatarUri: null };
  }
};

export const saveProfile = async ({ name, avatarUri }) => {
  const nextName = (name || '').trim() || DEFAULT_PROFILE_NAME;
  await Promise.all([
    AsyncStorage.setItem(PROFILE_NAME_KEY, nextName),
    avatarUri
      ? AsyncStorage.setItem(PROFILE_AVATAR_KEY, avatarUri)
      : AsyncStorage.removeItem(PROFILE_AVATAR_KEY),
  ]);
  return { name: nextName, avatarUri: avatarUri || null };
};

// 相册选择器给的可能是缓存路径，必须复制到应用目录，重启后才不会失效。
export const persistAvatar = async (uri) => {
  if (!uri) return null;
  if (uri.startsWith(FileSystem.documentDirectory || '###')) return uri;
  const dir = `${FileSystem.documentDirectory}profile`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const ext = (String(uri).split('?')[0].match(/\.(jpe?g|png|webp)$/i) || [])[1] || 'jpg';
  const dest = `${dir}/avatar_${Date.now()}.${ext}`;
  await FileSystem.copyAsync({ from: uri, to: dest });
  return dest;
};
