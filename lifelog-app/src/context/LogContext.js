import React, { createContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initialLogData } from '../data/mockData';
import { fetchSuggestions } from '../utils/search';
import { downloadRemoteCover } from '../utils/media';

export const LogContext = createContext();

export const LogProvider = ({ children }) => {
  const [logData, setLogData] = useState([]);

  useEffect(() => {
    loadLogs();
  }, []);

  const loadLogs = async () => {
    try {
      const storedLogs = await AsyncStorage.getItem('@lifelogs');
      if (storedLogs) {
        const logs = JSON.parse(storedLogs);
        setLogData(logs);
        backfillCovers(logs);
      } else {
        setLogData(initialLogData);
        await AsyncStorage.setItem('@lifelogs', JSON.stringify(initialLogData));
      }
    } catch (e) {
      console.error('加载数据失败', e);
    }
  };

  // 旧数据回填：没有本地图也没有封面的娱乐记录，按标题查一次联想接口补一张网络海报
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
      backfillAttempted.add(log.id);
      try {
        const results = await fetchSuggestions(log.title, log.subType);
        const artwork = results[0]?.artwork;
        if (artwork) {
          const coverUrl = await downloadRemoteCover(artwork);
          updated = (updated || [...logs]).map(l =>
            l.id === log.id ? { ...l, coverUrl } : l
          );
        }
      } catch {
        // 网络不可用就跳过，下次启动再试
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
      const updatedLogs = logData.map(log => log.id === updatedLog.id ? updatedLog : log);
      setLogData(updatedLogs);
      await AsyncStorage.setItem('@lifelogs', JSON.stringify(updatedLogs));
    } catch (e) {
      console.error('更新数据失败', e);
    }
  };

  return (
    // 记得把新方法暴露出去
    <LogContext.Provider value={{ logData, addLog, deleteLog, updateLog }}>
      {children}
    </LogContext.Provider>
  );
};