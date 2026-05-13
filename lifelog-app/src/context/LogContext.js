import React, { createContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initialLogData } from '../data/mockData';

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
        setLogData(JSON.parse(storedLogs));
      } else {
        setLogData(initialLogData);
        await AsyncStorage.setItem('@lifelogs', JSON.stringify(initialLogData));
      }
    } catch (e) {
      console.error('加载数据失败', e);
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