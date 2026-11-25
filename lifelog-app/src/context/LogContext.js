import React, { createContext, useState, useEffect, useRef, useCallback } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { initialLogData } from '../data/mockData';
import { fetchSuggestions, withTimeout } from '../utils/search';
import {
  downloadRemoteCoverVariants,
  cleanTransientCaches,
  enforceCacheCaps,
  clearMotionVideos,
  isVideoEntry,
  mediaSignature,
  purgeReferencedMediaCopies,
  dedupeAndOptimizeCovers,
} from '../utils/media';
import { clearMotionVideoCache } from '../utils/livePhoto';
import { syncMediaFromGallery, warmGalleryIndex } from '../utils/mediaSync';
import { writeInternalBackup } from '../utils/backup';
import { loadProfile } from '../utils/profile';
import { detectMediaMetadata } from '../utils/mediaMetadata';
import { rebaseLogFileUris } from '../utils/storagePaths';

export const LogContext = createContext();

// 记录存储键。带版本号：数据落点/格式有破坏性变化时直接换键，老数据不读也不迁移
const LOGS_KEY = '@lifelogs_v2';

export const LogProvider = ({ children }) => {
  const [logData, setLogData] = useState([]);
  const [tdtKey, setTdtKeyState] = useState('');
  // 地图服务商：iOS 默认 'apple'（原生 MapKit 免密钥），可选 'tianditu' | 'amap'；Android 仅 'tianditu' | 'amap'
  const [mapProvider, setProviderState] = useState(Platform.OS === 'ios' ? 'apple' : 'tianditu');
  const [amapKey, setAmapKeyState] = useState('');
  // 高德矢量渲染（官方 JS API 2.0）：Web端(JS API) key + 安全密钥。
  // 填了就用矢量渲染，没填自动用栅格瓦片（免 key）；这两把 key 和上面那把
  // 「Web 服务」key 各管一件事，互不通用。
  const [amapJsKey, setAmapJsKeyState] = useState('');
  const [amapJsCode, setAmapJsCodeState] = useState('');
  const logDataRef = useRef([]);
  const keysRef = useRef({});
  const backupHydratedRef = useRef(false);
  const backupDirtyRef = useRef(false);
  const backupTimerRef = useRef(null);
  const metadataTimersRef = useRef(new Set());
  const metadataRunningRef = useRef(new Set());

  const flushInternalBackup = useCallback(async () => {
    if (!backupDirtyRef.current) return;
    backupDirtyRef.current = false;
    if (!backupHydratedRef.current) return;
    clearTimeout(backupTimerRef.current);
    try {
      const profile = await loadProfile();
      await writeInternalBackup({
        logData: logDataRef.current,
        keys: keysRef.current,
        profile,
      });
    } catch (e) {
      console.warn('[backup] 内部备份写入失败', e?.message || e);
    }
  }, []);

  const scheduleInternalBackup = useCallback(() => {
    if (!backupHydratedRef.current) return;
    clearTimeout(backupTimerRef.current);
    backupDirtyRef.current = true;
    backupTimerRef.current = setTimeout(flushInternalBackup, 2500);
  }, [flushInternalBackup]);

  useEffect(() => {
    logDataRef.current = logData;
    scheduleInternalBackup();
  }, [logData, scheduleInternalBackup]);

  useEffect(() => {
    keysRef.current = { tdtKey, mapProvider, amapKey, amapJsKey, amapJsCode };
    scheduleInternalBackup();
  }, [tdtKey, mapProvider, amapKey, amapJsKey, amapJsCode, scheduleInternalBackup]);

  useEffect(() => () => {
    clearTimeout(backupTimerRef.current);
    for (const timer of metadataTimersRef.current) clearTimeout(timer);
  }, []);

  /* 实况照片提取出来的动效视频（motionVideos/）只是"这次会话的临时文件"：
     进后台就整体清掉（下次看再提取一遍，反正点开详情页会预热），
     磁盘清掉的同时也把内存里的"已就绪"表清掉，否则会拿到已经不存在的路径。
     启动时再兜底清一遍，防止进程被系统杀掉时留下残留。 */
  const clearMotionCache = () => {
    clearMotionVideoCache();
    clearMotionVideos().catch(() => {});
  };

  useEffect(() => {
    loadLogs();
    clearMotionCache();
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        clearMotionCache();
        flushInternalBackup();
      }
    });
    // 天地图 Key：侧边栏「地图服务 Key」里配置，存本机
    AsyncStorage.getItem('@tdt_key').then(v => { if (v) setTdtKeyState(v); }).catch(() => {});
    AsyncStorage.getItem('@map_provider').then(v => { if (v === 'amap' || v === 'tianditu' || (v === 'apple' && Platform.OS === 'ios')) setProviderState(v); }).catch(() => {});
    AsyncStorage.getItem('@amap_key').then(v => { if (v) setAmapKeyState(v); }).catch(() => {});
    AsyncStorage.getItem('@amap_js_key').then(v => { if (v) setAmapJsKeyState(v); }).catch(() => {});
    AsyncStorage.getItem('@amap_js_code').then(v => { if (v) setAmapJsCodeState(v); }).catch(() => {});
    return () => appStateSub.remove();
  }, [flushInternalBackup]);

  const setTdtKey = async (key) => {
    const next = (key || '').trim();
    setTdtKeyState(next);
    try {
      await AsyncStorage.setItem('@tdt_key', next);
    } catch (e) {
      console.error('保存天地图Key失败', e);
    }
  };

  const setMapProvider = async (provider) => {
    const next = provider === 'apple' && Platform.OS === 'ios'
      ? 'apple'
      : (provider === 'amap' ? 'amap' : 'tianditu');
    setProviderState(next);
    try {
      await AsyncStorage.setItem('@map_provider', next);
    } catch (e) {
      console.error('保存地图服务商失败', e);
    }
  };

  const setAmapKey = async (key) => {
    const next = (key || '').trim();
    setAmapKeyState(next);
    try {
      await AsyncStorage.setItem('@amap_key', next);
    } catch (e) {
      console.error('保存高德Key失败', e);
    }
  };

  const setAmapJsKey = async (key) => {
    const next = (key || '').trim();
    setAmapJsKeyState(next);
    try {
      await AsyncStorage.setItem('@amap_js_key', next);
    } catch (e) {
      console.error('保存高德 JS API Key 失败', e);
    }
  };

  const setAmapJsCode = async (code) => {
    const next = (code || '').trim();
    setAmapJsCodeState(next);
    try {
      await AsyncStorage.setItem('@amap_js_code', next);
    } catch (e) {
      console.error('保存高德安全密钥失败', e);
    }
  };

  const commitLogs = async (nextLogs) => {
    logDataRef.current = nextLogs;
    setLogData(nextLogs);
    try {
      await AsyncStorage.setItem(LOGS_KEY, JSON.stringify(nextLogs));
    } catch (e) {
      console.error('保存数据失败', e);
    }
    scheduleInternalBackup();
  };

  const runMediaMetadata = async (ids) => {
    for (const id of ids) {
      if (metadataRunningRef.current.has(id)) continue;
      metadataRunningRef.current.add(id);
      try {
        const initial = logDataRef.current.find((log) => log.id === id);
        if (!initial?.localImages?.length) continue;
        const updates = new Map();
        for (const entry of [...initial.localImages]) {
          const video = isVideoEntry(entry);
          if (video) {
            if (entry.videoPoster?.base64 || entry.videoPoster?.uri || entry.metadataCheckedAt) continue;
          } else if (['live', 'not-live', 'unknown'].includes(entry?.liveStatus) && !(Platform.OS === 'ios' && entry?.assetId && entry?.liveSource !== 'ios')) {
            continue;
          }

          const detected = await detectMediaMetadata(entry);
          const key = mediaSignature(entry);
          if (key) updates.set(key, detected);
        }
        if (updates.size) {
          const current = logDataRef.current.find((log) => log.id === id);
          if (!current?.localImages?.length) continue;
          const nextEntries = current.localImages.map((entry) => (
            updates.get(mediaSignature(entry)) || entry
          ));
          await commitLogs(logDataRef.current.map((log) => (
            log.id === id ? { ...log, localImages: nextEntries } : log
          )));
        }
      } catch (e) {
        console.warn('[media] 影像元数据检测失败', id, e?.message || e);
      } finally {
        metadataRunningRef.current.delete(id);
      }
    }
  };

  const scheduleMediaMetadata = (ids = []) => {
    const unique = [...new Set(ids.filter((id) => id != null))];
    if (!unique.length) return;
    const timer = setTimeout(() => {
      metadataTimersRef.current.delete(timer);
      runMediaMetadata(unique);
    }, 900);
    metadataTimersRef.current.add(timer);
  };

  const loadLogs = async () => {
    try {
      const storedLogs = await AsyncStorage.getItem(LOGS_KEY);
      if (storedLogs) {
        const rawLogs = JSON.parse(storedLogs);
        // iOS 升级/重装会改变应用容器 UUID：先将旧路径重定位到当前 documentDirectory，
        // 避免误判封面/视频封面/本地副本已丢失而被清掉
        let rebasedChanged = false;
        const logs = rawLogs.map((l) => {
          const next = rebaseLogFileUris(l);
          if (next !== l) rebasedChanged = true;
          return next;
        });
        // 封面文件不在了（换机导入、手删）就清掉，交给下面的回填按标题重新联网补一张
        let pruned = logs;
        for (const log of logs) {
          if (log?.coverUrl?.startsWith('file://')) {
            try {
              if (!(await FileSystem.getInfoAsync(log.coverUrl)).exists) {
                pruned = (pruned === logs ? [...logs] : pruned)
                  .map(l => (l.id === log.id ? { ...l, coverUrl: null, coverRatio: null } : l));
              }
            } catch {}
          }
        }
        logDataRef.current = pruned;
        setLogData(pruned);
        if (rebasedChanged || pruned !== logs) {
          await AsyncStorage.setItem(LOGS_KEY, JSON.stringify(pruned));
        }
        // 延后 2 秒错峰启动：给缺封面的记录联网补一张海报
        setTimeout(() => { backfillCovers(pruned); }, 2000);
      } else {
        logDataRef.current = initialLogData;
        setLogData(initialLogData);
        await AsyncStorage.setItem(LOGS_KEY, JSON.stringify(initialLogData));
      }
    } catch (e) {
      console.error('加载数据失败', e);
    } finally {
      backupHydratedRef.current = true;
      // 启动加载完成，只有后续数据真正变动时才写内部备份（避免冷启动 800ms 读全量封面卡顿）
      const incompleteIds = logDataRef.current
        .filter((log) => log.localImages?.some((entry) => (
          entry.liveStatus === 'pending'
          || (entry.liveStatus === 'not-applicable' && !entry.metadataCheckedAt)
          || entry.liveStatus === 'unknown'
          || (Platform.OS === 'ios' && !isVideoEntry(entry) && entry.assetId && entry.liveSource !== 'ios')
        )))
        .map((log) => log.id);
      scheduleMediaMetadata(incompleteIds);
      cleanTransientCaches();
      // 封面帧/实况提取缓存超限则整体清理，防止长期使用缓存无限膨胀
      enforceCacheCaps();
      // 静默预热相册索引（不弹权限窗）：保存记录时把媒体重链成相册引用可以零等待
      // 但不要卡在启动那一刻：首屏渲染和用户开始滑列表都是这几秒，
      // 一次全量扫相册（分页拉几千条）会把 JS 线程挤得一顿一顿，晚几秒再跑
      if (Platform.OS !== 'ios') setTimeout(warmGalleryIndex, 6000);
    }
  };

  // 旧数据回填：没有本地图也没有封面的影视/地点记录，按标题查一次联想接口补一张网络海报。
  // 触发时机：启动、每次"同步相册影像"后、备份导入后。
  // 失败（网络/超时）的记录撤销标记，下次触发自动重试；只有"确实搜不到海报"才不再空搜
  const backfillAttempted = new Set();
  const backfillCovers = async (logs) => {
    const pending = logs.filter(log =>
      log.baseType === 'media' && !log.coverUrl &&
      !(log.localImages && log.localImages.length) &&
      !backfillAttempted.has(log.id)
    );
    if (pending.length === 0) return;

    let updated = null;
    for (const log of pending) {
      try {
        const results = await withTimeout(fetchSuggestions(log.title, log.subType));
        const artwork = results[0]?.artwork;
        if (artwork) {
          const cover = await withTimeout(downloadRemoteCoverVariants(artwork));
          updated = (updated || [...logDataRef.current]).map(l =>
            l.id === log.id
              ? { ...l, coverUrl: cover.coverUrl, coverThumbUrl: cover.coverThumbUrl }
              : l
          );
        } else {
          backfillAttempted.add(log.id);
        }
      } catch {
        // 请求失败：撤销标记，下次同步/启动重试
        backfillAttempted.delete(log.id);
      }
    }
    if (updated) {
      await commitLogs(updated);
    }
  };

  const addLog = async (newLog) => {
    try {
      const updatedLogs = [newLog, ...logDataRef.current];
      await commitLogs(updatedLogs);
      scheduleMediaMetadata([newLog.id]);
    } catch (e) {
      console.error('保存数据失败', e);
    }
  };

  // ✨ 新增：删除记录
  const deleteLog = async (id) => {
    try {
      const updatedLogs = logDataRef.current.filter(log => log.id !== id);
      await commitLogs(updatedLogs);
    } catch (e) {
      console.error('删除数据失败', e);
    }
  };

  // ✨ 新增：更新记录
  const updateLog = async (updatedLog) => {
    try {
      // 合并而不是整对象替换：保存表单里没有涉及的字段（比如详情页里长按设的
      // coverThumbUrl / coverIndex）不会被这次编辑抹掉；显式传 null 仍然会覆盖
      const patch = Object.fromEntries(
        Object.entries(updatedLog).filter(([, v]) => v !== undefined)
      );
      const updatedLogs = logDataRef.current.map(log => (log.id === updatedLog.id ? { ...log, ...patch } : log));
      await commitLogs(updatedLogs);
      if (patch.localImages) scheduleMediaMetadata([updatedLog.id]);
    } catch (e) {
      console.error('更新数据失败', e);
    }
  };

  // 相册同步：扫描相册，把断链的媒体引用重新关联到原片（换机/重装/旧数据迁移后的修复入口）
  const syncMedia = async (onProgress) => {
    const report = await syncMediaFromGallery(logData, onProgress);
    if (report.changed) {
      await commitLogs(report.logs);
      scheduleMediaMetadata(report.logs.filter((log) => log.localImages?.length).map((log) => log.id));
    }
    // 同步完成后立刻补拉缺失的封面，不用等下次重启
    backfillCovers(report.changed ? report.logs : logData);
    return report;
  };

  // 备份导入：replace 覆盖现有数据，merge 按 id 合并（备份里的同 id 记录覆盖本地）
  // 手动清除「仍被记录引用但相册里找不到原片」的本地副本，并同步从对应记录中摘除已删照片
  const purgeReferencedCopies = async () => {
    const res = await purgeReferencedMediaCopies(logDataRef.current);
    if (res.changed) {
      await commitLogs(res.logs);
    }
    return res;
  };
  // 清理并合并重复/高清旧封面，更新记录后立即重写本地自动备份使其同步瘦身
  const dedupeCovers = async () => {
    const res = await dedupeAndOptimizeCovers(logDataRef.current);
    if (res.changed) {
      await commitLogs(res.logs);
      await flushInternalBackup();
    }
    return res;
  };

  // 用户在「数据与存储」中手动删除某个本地文件后，同步摘除记录中指向该文件的失效引用
  const removeMediaFileReference = async (fileName) => {
    const base = String(fileName || '').trim();
    if (!base) return false;
    const matches = (uri) => typeof uri === 'string' && uri.startsWith('file://') && uri.split('?')[0].split('/').pop() === base;
    let changed = false;
    const nextLogs = logDataRef.current.map((log) => {
      if (!log) return log;
      let dirty = false;
      const copy = { ...log };
      if (matches(copy.coverUrl)) { copy.coverUrl = null; dirty = true; }
      if (matches(copy.coverThumbUrl)) { copy.coverThumbUrl = null; dirty = true; }
      if (Array.isArray(copy.localImages) && copy.localImages.length) {
        const nextImages = [];
        let imgsDirty = false;
        for (const entry of copy.localImages) {
          if (typeof entry === 'string') {
            if (matches(entry)) { imgsDirty = true; continue; }
            nextImages.push(entry);
            continue;
          }
          if (entry && typeof entry === 'object') {
            if (matches(entry.uri)) { imgsDirty = true; continue; }
            if (entry.videoPoster && matches(entry.videoPoster.uri)) {
              const nextEntry = { ...entry };
              delete nextEntry.videoPoster;
              nextImages.push(nextEntry);
              imgsDirty = true;
              continue;
            }
          }
          nextImages.push(entry);
        }
        if (imgsDirty) {
          copy.localImages = nextImages;
          dirty = true;
        }
      }
      if (dirty) {
        changed = true;
        return copy;
      }
      return log;
    });
    if (changed) {
      await commitLogs(nextLogs);
      await flushInternalBackup();
    }
    return changed;
  };

  const importLogs = async (incoming, mode = 'merge') => {
    let next;
    let added = 0;
    let updated = 0;
    if (mode === 'replace') {
      next = incoming.filter(l => l && l.id != null && l.date);
    } else {
      const byId = new Map(logDataRef.current.filter(l => l && l.id != null).map(l => [l.id, l]));
      const existingIds = new Set(byId.keys());
      incoming.forEach(l => {
        if (!l || l.id == null || !l.date) return;
        byId.set(l.id, l);
        if (existingIds.has(l.id)) updated++;
        else added++;
      });
      next = [...byId.values()];
    }
    await commitLogs(next);
    scheduleMediaMetadata(next.filter((log) => log.localImages?.length).map((log) => log.id));
    // 导入完成后立刻补拉缺失的封面，不用等下次重启
    backfillCovers(next);
    return { total: next.length, added, updated };
  };

  // 详情页按需生成视频封面后，把 base64 合并回当前记录。
  // 用 logDataRef 做二次查找，避免多个视频并发完成时互相覆盖。
  const saveVideoPoster = async (logId, entrySeed, poster) => {
    if (!poster?.uri && !poster?.base64) return;
    const current = logDataRef.current.find((log) => log.id === logId);
    if (!current?.localImages?.length) return;
    const key = mediaSignature(entrySeed);
    let changed = false;
    const nextImages = current.localImages.map((entry) => {
      if (mediaSignature(entry) !== key) return entry;
      changed = true;
      return {
        ...entry,
        videoPoster: poster,
        liveStatus: 'not-applicable',
        metadataCheckedAt: Date.now(),
      };
    });
    if (!changed) return;
    await commitLogs(logDataRef.current.map((log) => (
      log.id === logId ? { ...log, localImages: nextImages } : log
    )));
  };

  return (
    // 记得把新方法暴露出去
    <LogContext.Provider value={{
      logData, addLog, deleteLog, updateLog, syncMedia, purgeReferencedCopies, dedupeCovers, removeMediaFileReference, importLogs,
      saveVideoPoster,
      tdtKey, setTdtKey, mapProvider, setMapProvider, amapKey, setAmapKey,
      amapJsKey, setAmapJsKey, amapJsCode, setAmapJsCode,
      requestBackupSync: scheduleInternalBackup,
    }}>
      {children}
    </LogContext.Provider>
  );
};
