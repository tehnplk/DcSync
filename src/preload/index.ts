import { contextBridge, ipcRenderer } from 'electron'
import type { Icd, Result, Settings, Update } from './types'

const api = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  getUpdate: (): Promise<Update | null> => ipcRenderer.invoke('update:get'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdate: (cb: (u: Update | null) => void): (() => void) => {
    const h = (_: unknown, u: Update | null): void => cb(u)
    ipcRenderer.on('update', h)
    return () => ipcRenderer.removeListener('update', h)
  },
  saveSettings: (s: Settings): Promise<void> => ipcRenderer.invoke('settings:save', s),
  test: (s: Settings): Promise<Result> => ipcRenderer.invoke('db:test', s),
  start: (s: Settings): Promise<Result> => ipcRenderer.invoke('server:start', s),
  stop: (): Promise<void> => ipcRenderer.invoke('server:stop'),
  newToken: (): Promise<string> => ipcRenderer.invoke('token:new'),
  searchIcd: (s: Settings, q: string): Promise<{ ok: true; rows: Icd[] } | Result> => ipcRenderer.invoke('icd:search', s, q),
  onLog: (cb: (m: string) => void): (() => void) => {
    const h = (_: unknown, m: string): void => cb(m)
    ipcRenderer.on('log', h)
    return () => ipcRenderer.removeListener('log', h)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
