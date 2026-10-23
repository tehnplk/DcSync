import { app, shell, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { DEFAULT_ICD, type AlertStatus, type Icd, type Result, type Settings, type Update } from '../preload/types'
import { PORT, checkAlerts, mophPost, searchIcd, start, stop, testConn, today, urls, type Sent } from './agent'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

export const newToken = (): string => randomBytes(24).toString('base64url')

const DEFAULTS: Settings = {
  conn: { engine: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'hos' },
  from: today(-30),
  to: today(),
  port: PORT,
  origins: 'https://dc.plkhealth.go.th, http://localhost:3000',
  token: newToken(),
  icd10: DEFAULT_ICD,
  demo: false,
  alerts: [],
  mophKey: '',
  mophSecret: ''
}

// ตั้งค่าเก็บใน userData/settings.json — รหัสผ่าน HIS และคีย์ MOPH Alert เข้ารหัสด้วย safeStorage (ผูกกับบัญชี Windows)
const file = (): string => join(app.getPath('userData'), 'settings.json')
let settings: Settings = DEFAULTS

const enc = (v: string): string =>
  safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(v).toString('base64') : v
const dec = (v: string = ''): string =>
  v.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : v

function load(): Settings {
  if (!existsSync(file())) return DEFAULTS
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8'))
    // ช่วงวันที่ไม่จำข้ามรอบ — เปิดโปรแกรมใหม่ = ย้อนหลัง 30 วันถึงวันนี้เสมอ
    return {
      ...DEFAULTS, ...s, from: today(-30), to: today(),
      conn: { ...DEFAULTS.conn, ...s.conn, password: dec(s.conn?.password) },
      mophKey: dec(s.mophKey), mophSecret: dec(s.mophSecret)
    }
  } catch {
    return DEFAULTS
  }
}

function save(s: Settings): void {
  settings = s
  const out = { ...s, conn: { ...s.conn, password: enc(s.conn.password) }, mophKey: enc(s.mophKey), mophSecret: enc(s.mophSecret) }
  writeFileSync(file(), JSON.stringify(out, null, 2))
}

/**
 * ตัวแจ้งเตือน — ทำงานเฉพาะตอน Start: ตรวจทันที แล้วทุก 5 นาที ใช้วันนี้ของแต่ละรอบ (ข้ามเที่ยงคืนเปลี่ยนวันเอง)
 * คีย์ที่ส่งแล้วเก็บใน userData/moph-sent.json — เปิดโปรแกรมใหม่ไม่ส่งซ้ำ
 */
const ALERT_EVERY = 5 * 60 * 1000
const sentFile = (): string => join(app.getPath('userData'), 'moph-sent.json')
let alertTimer: NodeJS.Timeout | null = null
let checking = false
let alertStatus: AlertStatus | null = null
let skipped = ''   // ข้อความข้ามล่าสุด — ลง log ครั้งเดียว ไม่ทุกรอบ

async function alertTick(): Promise<void> {
  if (checking) return   // รอบก่อนยังไม่จบ (HIS/MOPH ช้า) — ไม่ซ้อน ไม่งั้นส่งซ้ำได้
  checking = true
  let r: Result & { skip?: true }
  try {
    let sent: Sent = {}
    try {
      sent = JSON.parse(readFileSync(sentFile(), 'utf8'))
    } catch {
      // ยังไม่มีไฟล์ / ไฟล์เสีย = เริ่มใหม่
    }
    const { mophKey, mophSecret } = settings
    r = mophKey && mophSecret
      ? await checkAlerts(settings, sent, (b) => mophPost(mophKey, mophSecret, b), log)
      : { ok: false, skip: true, message: 'แจ้งเตือน: ยังไม่ได้ตั้ง Client key / Secret key — ไม่ส่ง' }
    writeFileSync(sentFile(), JSON.stringify(sent))
    const skip = 'skip' in r ? r.message : ''
    if (skip && skip !== skipped) log(skip)
    skipped = skip
  } catch (e) {
    r = fail(e)
    log(`แจ้งเตือน: ตรวจไม่สำเร็จ — ${r.message}`)
  } finally {
    checking = false
  }
  alertStatus = { ...r, at: new Date().toLocaleString('th-TH') }
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('alert', alertStatus))
}

function stopAlerts(): void {
  if (alertTimer) clearInterval(alertTimer)
  alertTimer = null
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
  ipcMain.handle('alert:get', () => alertStatus)
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
      if (!s.demo) await testConn(s.conn) // ต่อ DB ไม่ได้ ไม่ต้องเปิดพอร์ตให้เว็บเรียกแล้วพังทุกครั้ง · โหมดสาธิตไม่ใช้ DB
      await start(() => settings, log)
      const at = urls(s.port).join(', ')
      log(`เริ่มให้บริการที่ ${at}`)
      stopAlerts()
      skipped = ''
      void alertTick()
      alertTimer = setInterval(alertTick, ALERT_EVERY)
      return { ok: true, message: `ให้บริการที่ ${at}` }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return err.code === 'EADDRINUSE' ? { ok: false, message: `พอร์ต ${s.port} ถูกใช้อยู่ ลองเปลี่ยนพอร์ต` } : fail(e)
    }
  })
  ipcMain.handle('server:stop', async () => {
    stopAlerts()
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
