import { app, shell, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { DEFAULT_ICD, type Icd, type Result, type Settings, type Update } from '../preload/types'
import { PORT, searchIcd, start, stop, testConn } from './agent'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

const today = (d = 0): string => {
  const t = new Date(Date.now() + d * 86400000)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

export const newToken = (): string => randomBytes(24).toString('base64url')

const DEFAULTS: Settings = {
  conn: { engine: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'hos' },
  from: today(-30),
  to: today(),
  origins: 'https://dc.plkhealth.go.th, http://localhost:3000',
  token: newToken(),
  icd10: DEFAULT_ICD
}

// ตั้งค่าเก็บใน userData/settings.json — รหัสผ่านเข้ารหัสด้วย safeStorage (ผูกกับบัญชี Windows)
const file = (): string => join(app.getPath('userData'), 'settings.json')
let settings: Settings = DEFAULTS

function load(): Settings {
  if (!existsSync(file())) return DEFAULTS
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8'))
    const pw: string = s.conn?.password ?? ''
    const password = pw.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(pw.slice(4), 'base64')) : pw
    // ช่วงวันที่ไม่จำข้ามรอบ — เปิดโปรแกรมใหม่ = ย้อนหลัง 30 วันถึงวันนี้เสมอ
    return { ...DEFAULTS, ...s, from: today(-30), to: today(), conn: { ...DEFAULTS.conn, ...s.conn, password } }
  } catch {
    return DEFAULTS
  }
}

function save(s: Settings): void {
  settings = s
  const pw = safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(s.conn.password).toString('base64')
    : s.conn.password
  writeFileSync(file(), JSON.stringify({ ...s, conn: { ...s.conn, password: pw } }, null, 2))
}

const fail = (e: unknown): Result => ({ ok: false, message: (e as Error).message || String(e) })

// ส่งข้อความเข้าแท็บบันทึกการทำงาน
const log = (m: string): void =>
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('log', `${new Date().toLocaleTimeString('th-TH')} ${m}`))

/**
 * อัปเดตอัตโนมัติจาก GitHub Releases (electron-builder.yml → publish) — ดาวน์โหลดเบื้องหลัง
 * บอกผู้ใช้ให้เห็น: แถบบนของหน้าต่าง (สถานะ/ปุ่มอัปเดต) + กล่องถาม "ติดตั้งและเปิดใหม่ / ภายหลัง" เมื่อโหลดเสร็จ
 * ภายหลัง = ติดตั้งตอนปิดโปรแกรม (autoInstallOnAppQuit) · เช็คตอนเปิด แล้วซ้ำทุก 4 ชม. (เปิดค้างทั้งวันก็เจอ)
 * เฉพาะตัวติดตั้งจริง — dev ทดสอบได้ด้วย DCSYNC_TEST_UPDATE=1 (อ่าน dev-app-update.yml)
 */
let update: Update | null = null
const sendUpdate = (): void => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('update', update))
let updating = false

function checkUpdates(): void {
  if (updating) return   // หน้าต่างโหลดใหม่ (F5) ไม่ต้องผูก event ซ้ำ
  updating = true
  autoUpdater.on('update-available', (i) => {
    update = { state: 'downloading', version: i.version, percent: 0 }
    sendUpdate()
    log(`พบเวอร์ชันใหม่ ${i.version} กำลังดาวน์โหลด…`)
  })
  autoUpdater.on('download-progress', (p) => {
    if (update?.state === 'downloading') {
      update = { ...update, percent: Math.round(p.percent) }
      sendUpdate()
    }
  })
  autoUpdater.on('update-downloaded', async (i) => {
    update = { state: 'ready', version: i.version }
    sendUpdate()
    log(`ดาวน์โหลดเวอร์ชัน ${i.version} แล้ว — กด "อัปเดต" ที่แถบบน หรือจะติดตั้งเองตอนปิดโปรแกรม`)
    const win = BrowserWindow.getAllWindows()[0]
    const opt = {
      type: 'info' as const,
      title: 'อัปเดต DcSync',
      message: `DcSync เวอร์ชัน ${i.version} พร้อมติดตั้ง`,
      detail: 'ติดตั้งตอนนี้: โปรแกรมจะปิดแล้วเปิดใหม่เอง (หยุดให้บริการไม่กี่วินาที)\nภายหลัง: ติดตั้งให้ตอนปิดโปรแกรม',
      buttons: ['ติดตั้งและเปิดใหม่', 'ภายหลัง'],
      defaultId: 0,
      cancelId: 1
    }
    const r = win ? await dialog.showMessageBox(win, opt) : await dialog.showMessageBox(opt)
    if (r.response === 0) autoUpdater.quitAndInstall(true, true)
  })
  autoUpdater.on('error', (e) => log(`เช็คอัปเดตไม่สำเร็จ: ${e.message}`))
  const check = (): void => void autoUpdater.checkForUpdates().catch(() => {})   // ออฟไลน์ก็ทำงานต่อ ข้อความไปที่ error
  check()
  setInterval(check, 4 * 60 * 60 * 1000)
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 760,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })
  // เช็คหลังหน้าโหลดเสร็จ สถานะอัปเดตจะได้ขึ้นที่แถบบน
  if (app.isPackaged || process.env.DCSYNC_TEST_UPDATE) {
    autoUpdater.forceDevUpdateConfig = !app.isPackaged
    mainWindow.webContents.once('did-finish-load', checkUpdates)
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('go.plkhealth.dcsync')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  settings = load()

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('update:get', () => update)
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true))
  ipcMain.handle('settings:save', (_, s: Settings) => save(s))
  ipcMain.handle('token:new', () => newToken())
  ipcMain.handle('icd:search', async (_, s: Settings, q: string): Promise<{ ok: true; rows: Icd[] } | Result> => {
    try {
      return { ok: true, rows: await searchIcd(s.conn, q) }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('db:test', async (_, s: Settings): Promise<Result> => {
    try {
      return { ok: true, message: await testConn(s.conn) }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('server:start', async (_, s: Settings): Promise<Result> => {
    save(s)
    try {
      await testConn(s.conn) // ต่อ DB ไม่ได้ ไม่ต้องเปิดพอร์ตให้เว็บเรียกแล้วพังทุกครั้ง
      await start(() => settings, log)
      log(`เริ่มให้บริการที่ http://localhost:${PORT}`)
      return { ok: true, message: `กำลังให้บริการที่ http://localhost:${PORT}` }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return err.code === 'EADDRINUSE' ? { ok: false, message: `พอร์ต ${PORT} มีโปรแกรมอื่นใช้อยู่` } : fail(e)
    }
  })
  ipcMain.handle('server:stop', async () => {
    await stop()
    log('หยุดให้บริการ')
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
