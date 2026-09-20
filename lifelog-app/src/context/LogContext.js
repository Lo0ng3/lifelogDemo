import React, { createContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { initialLogData } from '../data/mockData';
import { fetchSuggestions, withTimeout } from '../utils/search';
import { downloadRemoteCover, cleanTransientCaches, migrateLegacyMedia, enforceCacheCaps, downscaleCover, resolveMediaUri } from '../utils/media';
import { syncMediaFromGallery, warmGalleryIndex } from '../utils/mediaSync';

export const LogContext = createContext();

export const LogProvider = ({ children }) => {
  const [logData, setLogData] = useState([]);
  const [tdtKey, setTdtKeyState] = useState('');
  // 地图服务商：'tianditu'（默认）| 'amap'；两家的 key 各自保存
  const [mapProvider, setProviderState] = useState('tianditu');
  const [amapKey, setAmapKeyState] = useState('');
  // 高德矢量渲染（官方 JS API 2.0）：Web端(JS API) key + 安全密钥。
  // 填了就用矢量渲染，没填自动用栅格瓦片（免 key）；这两把 key 和上面那把
  // 「Web 服务」key 各管一件事，互不通用。
  const [amapJsKey, setAmapJsKeyState] = useState('');
  const [amapJsCode, setAmapJsCodeState] = useState('');

  useEffect(() => {
    loadLogs();
    // 天地图 Key：侧边栏「地图服务 Key」里配置，存本机
    AsyncStorage.getItem('@tdt_key').then(v => { if (v) setTdtKeyState(v); }).catch(() => {});
    AsyncStorage.getItem('@map_provider').then(v => { if (v === 'amap' || v === 'tianditu') setProviderState(v); }).catch(() => {});
    AsyncStorage.getItem('@amap_key').then(v => { if (v) setAmapKeyState(v); }).catch(() => {});
    AsyncStorage.getItem('@amap_js_key').then(v => { if (v) setAmapJsKeyState(v); }).catch(() => {});
    AsyncStorage.getItem('@amap_js_code').then(v => { if (v) setAmapJsCodeState(v); }).catch(() => {});
  }, []);

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
    const next = provider === 'amap' ? 'amap' : 'tianditu';
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

  const loadLogs = async () => {
    try {
      const storedLogs = await AsyncStorage.getItem('@lifelogs');
      if (storedLogs) {
        const logs = JSON.parse(storedLogs);
        // 必须先迁移（把旧记录引用的缓存媒体挪进持久目录），再清理瞬时缓存，顺序不能反
        const { logs: migrated, changed } = await migrateLegacyMedia(logs);
        // 换机导入后本地封面文件不存在了，清掉让 backfillCovers 按标题重新联网补海报
        let pruned = migrated;
        for (const log of migrated) {
          if (log?.coverUrl?.startsWith('file://')) {
            try {
              if (!(await FileSystem.getInfoAsync(log.coverUrl)).exists) {
                pruned = (pruned === migrated ? [...migrated] : pruned)
                  .map(l => (l.id === log.id ? { ...l, coverUrl: null, coverRatio: null } : l));
              }
            } catch {}
          }
        }
        const hasChange = changed || pruned !== migrated;
        setLogData(pruned);
        if (hasChange) {
          await AsyncStorage.setItem('@lifelogs', JSON.stringify(pruned));
        }
        // 延后 2 秒错峰启动：① 存量大封面一次性迁移（>720px 重缩成小图）② 封面回填
        setTimeout(async () => {
          try {
            let migrated = null;
            for (let i = 0; i < pruned.length; i++) {
              const url = pruned[i]?.coverUrl;
              if (typeof url !== 'string' || !url.startsWith('file://')) continue;
              const small = await downscaleCover(url);
              if (small && small !== url) {
                migrated = migrated || [...pruned];
                migrated[i] = { ...migrated[i], coverUrl: small };
                try { await FileSystem.deleteAsync(url, { idempotent: true }); } catch {}
              }
            }
            let current = pruned;
            if (migrated) {
              current = migrated;
              setLogData(migrated);
              try { await AsyncStorage.setItem('@lifelogs', JSON.stringify(migrated)); } catch {}
            }
            // 自选封面小图补齐：老记录选了相册封面但没有小图文件的，生成一份（一次性，之后走设置时的即时生成）
            let thumbsAdded = false;
            for (let i = 0; i < current.length; i++) {
              const log = current[i];
              if (log?.coverIndex == null || log.coverThumbUrl) continue;
              const entry = (log.localImages || [])[log.coverIndex];
              if (!entry) continue;
              try {
                const resolved = await resolveMediaUri(entry);
                const small = await downscaleCover(resolved || entry.uri || '');
                if (small) {
                  current = current.map((l, j) => (j === i ? { ...l, coverThumbUrl: small } : l));
                  thumbsAdded = true;
                }
              } catch {}
            }
            if (thumbsAdded) {
              setLogData(current);
              try { await AsyncStorage.setItem('@lifelogs', JSON.stringify(current)); } catch {}
            }
            backfillCovers(current);
          } catch {}
        }, 2000);
      } else {
        setLogData(initialLogData);
        await AsyncStorage.setItem('@lifelogs', JSON.stringify(initialLogData));
      }
    } catch (e) {
      console.error('加载数据失败', e);
    } finally {
      cleanTransientCaches();
      // 封面帧/实况提取缓存超限则整体清理，防止长期使用缓存无限膨胀
      enforceCacheCaps();
      // 静默预热相册索引（不弹权限窗）：保存记录时把媒体重链成相册引用可以零等待
      warmGalleryIndex();
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
          const coverUrl = await withTimeout(downloadRemoteCover(artwork));
          updated = (updated || [...logs]).map(l =>
            l.id === log.id ? { ...l, coverUrl } : l
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
      setLogData(updated);
      try {
        await AsyncStorage.setItem('@lifelogs', JSON.stringify(updated));
      } catch (e) {
        console.error('保存数据失败', e);
      }
    }
  };

  const addLog = async (newLog) => {
    try {
      const updatedLogs = [newLog, ...logData];
      setLogData(updatedLogs);
      await AsyncStorage.setItem('@lifelogs', JSON.stringify(updatedLogs));
    } catch (e) {
      console.error('保存数据失败', e);
    }
  };

  // ✨ 新增：删除记录
  const deleteLog = async (id) => {
    try {
      const updatedLogs = logData.filter(log => log.id !== id);
      setLogData(updatedLogs);
      await AsyncStorage.setItem('@lifelogs', JSON.stringify(updatedLogs));
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
      const updatedLogs = logData.map(log => (log.id === updatedLog.id ? { ...log, ...patch } : log));
      setLogData(updatedLogs);
      await AsyncStorage.setItem('@lifelogs', JSON.stringify(updatedLogs));
    } catch (e) {
      console.error('更新数据失败', e);
    }
  };

  // 相册同步：扫描相册，把断链的媒体引用重新关联到原片（换机/重装/旧数据迁移后的修复入口）
  const syncMedia = async (onProgress) => {
    const report = await syncMediaFromGallery(logData, onProgress);
    if (report.changed) {
      setLogData(report.logs);
      try {
        await AsyncStorage.setItem('@lifelogs', JSON.stringify(report.logs));
      } catch (e) {
        console.error('保存数据失败', e);
      }
    }
    // 同步完成后立刻补拉缺失的封面，不用等下次重启
    backfillCovers(report.changed ? report.logs : logData);
    return report;
  };

  // 备份导入：replace 覆盖现有数据，merge 按 id 合并（备份里的同 id 记录覆盖本地）
  const importLogs = async (incoming, mode = 'merge') => {
    let next;
    let added = 0;
    let updated = 0;
    if (mode === 'replace') {
      next = incoming.filter(l => l && l.id != null && l.date);
    } else {
      const byId = new Map(logData.filter(l => l && l.id != null).map(l => [l.id, l]));
      const existingIds = new Set(byId.keys());
      incoming.forEach(l => {
        if (!l || l.id == null || !l.date) return;
        byId.set(l.id, l);
        if (existingIds.has(l.id)) updated++;
        else added++;
      });
      next = [...byId.values()];
    }
    setLogData(next);
    try {
      await AsyncStorage.setItem('@lifelogs', JSON.stringify(next));
    } catch (e) {
      console.error('保存数据失败', e);
    }
    // 导入完成后立刻补拉缺失的封面，不用等下次重启
    backfillCovers(next);
    return { total: next.length, added, updated };
  };

  return (
    // 记得把新方法暴露出去
    <LogContext.Provider value={{
      logData, addLog, deleteLog, updateLog, syncMedia, importLogs,
      tdtKey, setTdtKey, mapProvider, setMapProvider, amapKey, setAmapKey,
      amapJsKey, setAmapJsKey, amapJsCode, setAmapJsCode,
    }}>
      {children}
    </LogContext.Provider>
  );
};
