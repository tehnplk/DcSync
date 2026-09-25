import { useEffect, useRef, useState } from 'react'
import { DEFAULT_ICD, type Engine, type Icd, type Result, type Settings, type Update } from '../../preload/types'

const PORTS: Record<Engine, number> = { mysql: 3306, postgres: 5432 }

const TABS = [
  ['his', 'เชื่อมต่อ HIS'],
  ['icd', 'ข้อมูลที่ดึง'],
  ['log', 'บันทึกการทำงาน'],
] as const
type Tab = (typeof TABS)[number][0]

function App(): React.JSX.Element {
  const [s, setS] = useState<Settings | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Result | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [tab, setTab] = useState<Tab>('his')
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<Update | null>(null)

  useEffect(() => {
    window.api.getSettings().then(setS)
    window.api.version().then(setVersion)
    window.api.getUpdate().then(setUpdate)
    const offUpdate = window.api.onUpdate(setUpdate)
    const offLog = window.api.onLog((m) => setLogs((l) => [m, ...l].slice(0, 100)))
    return () => { offUpdate(); offLog() }
  }, [])

  // บันทึกทุกครั้งที่แก้ — ระหว่าง Start อยู่ เปลี่ยนช่วงวันที่แล้ว /patients ใช้ค่าใหม่ทันที
  useEffect(() => {
    if (s) window.api.saveSettings(s)
  }, [s])

  if (!s) return <p className="pad">กำลังโหลด…</p>

  const conn = (k: keyof Settings['conn'], v: string): void =>
    setS({ ...s, conn: { ...s.conn, [k]: k === 'port' ? Number(v) || 0 : v } })

  const engine = (e: Engine): void =>
    // เปลี่ยนชนิดฐาน ถ้าพอร์ตยังเป็นค่าตั้งต้นของอีกชนิด เปลี่ยนตามให้
    setS({ ...s, conn: { ...s.conn, engine: e, port: s.conn.port === PORTS[s.conn.engine] ? PORTS[e] : s.conn.port } })

  const run = async (f: () => Promise<Result>): Promise<Result> => {
    setBusy(true)
    setMsg(null)
    const r = await f()
    setMsg(r)
    setBusy(false)
    return r
  }

  const toggle = async (): Promise<void> => {
    if (running) {
      await window.api.stop()
      setRunning(false)
      setMsg(null)
    } else if ((await run(() => window.api.start(s))).ok) {
      setRunning(true)
      setMsg(null)   // สถานะมุมขวาบอกอยู่แล้ว ไม่ต้องขึ้นแถบซ้ำ — แถบไว้บอกผลทดสอบ/ข้อผิดพลาด
    }
  }

  return (
    <div className="app">
      {/* แถบบน: สถานะ + Start/Stop เห็นจากทุกแท็บ */}
      <header className="topbar">
        <h1>DcSync</h1>
        {version && <span className="ver">v{version}</span>}
        {update?.state === 'downloading' && (
          <span className="upd">กำลังดาวน์โหลดเวอร์ชัน {update.version} ({update.percent}%)</span>
        )}
        {update?.state === 'ready' && (
          <button type="button" className="upd-btn" onClick={() => window.api.installUpdate()}>
            อัปเดตเป็น {update.version}
          </button>
        )}
        <span className={`status ${running ? 'on' : ''}`}>
          <i aria-hidden />{running ? 'กำลังให้บริการที่ localhost:5000' : 'หยุดอยู่'}
        </span>
        <button type="button" className={running ? 'stop' : 'start'} disabled={busy} onClick={toggle}>
          {running ? 'Stop' : 'Start'}
        </button>
      </header>

      {msg && <p className={`banner ${msg.ok ? 'ok' : 'err'}`}>{msg.message}</p>}

      <nav className="tabs" role="tablist">
        {TABS.map(([k, t]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {t}{k === 'icd' ? ` (${s.icd10.length})` : k === 'log' && logs.length ? ` (${logs.length})` : ''}
          </button>
        ))}
      </nav>

      <main className="panel">
        <div role="tabpanel">
        {tab === 'his' && (
          <fieldset disabled={running}>
            <legend>ฐานข้อมูล HIS</legend>
            {running && <p className="hint">หยุดให้บริการ (Stop) ก่อนจึงแก้การเชื่อมต่อได้</p>}
            <div className="grid">
              <label>
                ชนิดฐานข้อมูล
                <select value={s.conn.engine} onChange={(e) => engine(e.target.value as Engine)}>
                  <option value="mysql">MySQL / MariaDB</option>
                  <option value="postgres">PostgreSQL</option>
                </select>
              </label>
              <label>
                ชื่อฐาน
                <input value={s.conn.database} onChange={(e) => conn('database', e.target.value)} />
              </label>
              <label>
                Host
                <input value={s.conn.host} onChange={(e) => conn('host', e.target.value)} />
              </label>
              <label>
                Port
                <input inputMode="numeric" value={s.conn.port || ''} onChange={(e) => conn('port', e.target.value)} />
              </label>
              <label>
                User
                <input value={s.conn.user} onChange={(e) => conn('user', e.target.value)} />
              </label>
              <label>
                Password
                <input type="password" value={s.conn.password} onChange={(e) => conn('password', e.target.value)} />
              </label>
            </div>
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => run(() => window.api.test(s))}>
                ทดสอบการเชื่อมต่อ
              </button>
            </div>
          </fieldset>
        )}


        {tab === 'icd' && (
          <>
            <fieldset>
              <legend>ช่วงวันที่รับบริการ</legend>
              <p className="hint">เปิดโปรแกรมใหม่ = ย้อนหลัง 30 วันถึงวันนี้ · แก้แล้วมีผลทันที</p>
              <div className="grid">
                {/* div ไม่ใช่ label — คลิกในปฏิทินจะได้ไม่เด้งไปกดปุ่มเปิด/ปิดซ้ำ */}
                <div className="field">
                  <span>ตั้งแต่</span>
                  <ThaiDate label="วันเริ่ม" value={s.from} max={s.to} onChange={(from) => setS({ ...s, from })} />
                </div>
                <div className="field">
                  <span>ถึง</span>
                  <ThaiDate label="วันสิ้นสุด" value={s.to} min={s.from} onChange={(to) => setS({ ...s, to })} />
                </div>
              </div>
            </fieldset>
            <IcdPicker s={s} value={s.icd10} onChange={(icd10) => setS({ ...s, icd10 })} />
          </>
        )}

        {tab === 'log' && (
          <fieldset>
            <legend>บันทึกการทำงาน</legend>
            {logs.length
              ? <pre className="log">{logs.join('\n')}</pre>
              : <p className="hint">ยังไม่มีรายการ — กด Start แล้วเรียก /patients จากเว็บ dc</p>}
          </fieldset>
        )}
        </div>

      </main>

      <div className="tokenwrap">
        {/* Token อยู่นอกแท็บ ใต้พื้นที่แท็บ — พื้นที่แท็บสูงคงที่เลื่อนในตัว Token จึงอยู่ที่เดิมทุกแท็บ (ต้องใช้ตอนตั้งค่าเว็บ dc) · div ไม่ใช่ label ชื่อปุ่มจะได้ไม่ปนกับชื่อช่อง */}
        <fieldset className="token">
          <legend id="token-label">Token (ใส่ในเว็บ dc เพื่อดึง /patients)</legend>
          <div className="row">
            <input className="grow mono" aria-labelledby="token-label" readOnly value={s.token}
                   onFocus={(e) => e.target.select()} />
            <button type="button" onClick={() => navigator.clipboard.writeText(s.token)}>คัดลอก</button>
            <button type="button" onClick={async () => setS({ ...s, token: await window.api.newToken() })}>สร้างใหม่</button>
          </div>
        </fieldset>
      </div>
    </div>
  )
}

// ปฏิทิน พ.ศ. แบบเดียวกับเว็บ dc — ค่าที่เก็บ/ส่ง API ยังเป็น yyyy-mm-dd ค.ศ.
const SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const LONG = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
const DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const pad = (n: number): string => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m + 1)}-${pad(d)}`
const todayIso = (): string => { const t = new Date(); return iso(t.getFullYear(), t.getMonth(), t.getDate()) }
const show = (v: string): string => {
  const [y, m, d] = v.split('-').map(Number)
  return y ? `${d} ${SHORT[m - 1]} ${y + 543}` : '—'
}

/**
 * ช่องวันที่ + ปฏิทิน พ.ศ. — <input type="date"> ของ Chromium บังคับ ค.ศ. และ mm/dd/yyyy ตาม locale เปลี่ยนไม่ได้
 * min/max = yyyy-mm-dd (วันเริ่มต้องไม่เกินวันสิ้นสุด) · ปิดเมื่อคลิกนอกกล่อง หรือกด Esc
 */
function ThaiDate({ value, min, max, onChange, label }: {
  value: string; min?: string; max?: string; onChange: (v: string) => void; label: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<[number, number]>([0, 0])   // [ปี ค.ศ., เดือน 0-11] ที่กำลังดู
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent): void => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', out)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc) }
  }, [open])

  const toggle = (): void => {
    const [y, m] = (value || todayIso()).split('-').map(Number)
    setView([y, m - 1])                     // เปิดมาที่เดือนของค่าปัจจุบันเสมอ
    setOpen((o) => !o)
  }
  const move = (n: number): void => setView(([y, m]) => [y + Math.floor((m + n) / 12), (((m + n) % 12) + 12) % 12])
  const pick = (v: string): void => { onChange(v); setOpen(false) }

  const [y, m] = view
  const first = new Date(y, m, 1).getDay()
  const days = new Date(y, m + 1, 0).getDate()
  const ok = (v: string): boolean => (!min || v >= min) && (!max || v <= max)
  const today = todayIso()

  return (
    <div className="thdate" ref={box}>
      <button type="button" className="thdate-text" aria-label={`${label} ${show(value)}`} aria-expanded={open} onClick={toggle}>
        {show(value)}
      </button>
      {open && (
        <div className="cal" role="dialog" aria-label={`เลือก${label}`}>
          <div className="cal-head">
            <button type="button" title="ปีก่อน" onClick={() => move(-12)}>«</button>
            <button type="button" title="เดือนก่อน" onClick={() => move(-1)}>‹</button>
            <b>{LONG[m]} {y + 543}</b>
            <button type="button" title="เดือนถัดไป" onClick={() => move(1)}>›</button>
            <button type="button" title="ปีถัดไป" onClick={() => move(12)}>»</button>
          </div>
          <div className="cal-grid">
            {DOW.map((d) => <span key={d} className="cal-dow">{d}</span>)}
            {Array.from({ length: first }, (_, i) => <span key={`b${i}`} />)}
            {Array.from({ length: days }, (_, i) => {
              const v = iso(y, m, i + 1)
              return (
                <button key={v} type="button" disabled={!ok(v)} onClick={() => pick(v)}
                        className={`cal-day ${v === value ? 'sel' : ''} ${v === today ? 'today' : ''}`}>
                  {i + 1}
                </button>
              )
            })}
          </div>
          <div className="cal-foot">
            <button type="button" disabled={!ok(today)} onClick={() => pick(today)}>วันนี้</button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * รหัส ICD10 ที่ดึง — ค้นจาก icd101 ของ HIS (ต้องตั้งค่าเชื่อมต่อให้ถูกก่อน) กดผลค้นเพื่อเพิ่ม กด × เพื่อเอาออก
 * แก้ระหว่าง Start อยู่ได้ /patients ใช้ชุดใหม่ทันที (บันทึกทุกครั้งที่แก้)
 */
function IcdPicker({ s, value, onChange }: { s: Settings; value: Icd[]; onChange: (v: Icd[]) => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Icd[]>([])
  const [err, setErr] = useState('')

  // ค้นหลังหยุดพิมพ์ 300 ms — ไม่ยิง DB ทุกตัวอักษร
  useEffect(() => {
    if (!q.trim()) {
      setHits([])
      setErr('')
      return
    }
    const t = setTimeout(async () => {
      const r = await window.api.searchIcd(s, q)
      if ('rows' in r) {
        setHits(r.rows)
        setErr(r.rows.length ? '' : 'ไม่พบรหัสนี้ใน icd101')
      } else {
        setHits([])
        setErr(`ค้นไม่ได้: ${r.message}`)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [q, s])

  const has = (c: string): boolean => value.some((v) => v.code === c)

  return (
    <fieldset>
      <legend>รหัส ICD10 ที่ดึง ({value.length})</legend>
      <div className="chips">
        {value.length === 0 && <span className="hint">ยังไม่ได้เลือกรหัส — /patients จะไม่มีคนไข้</span>}
        {value.map((v) => (
          <span key={v.code} className="chip" title={v.name}>
            <b className="mono">{v.code}</b> {v.name}
            <button type="button" aria-label={`เอา ${v.code} ออก`} onClick={() => onChange(value.filter((x) => x.code !== v.code))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="ค้นรหัสหรือชื่อโรค เช่น A90, dengue" aria-label="ค้นรหัส ICD10" />
        <button type="button" onClick={() => onChange(DEFAULT_ICD)}>คืนค่าเริ่มต้น</button>
      </div>
      {err && <p className="hint">{err}</p>}
      {hits.length > 0 && (
        <ul className="hits">
          {hits.map((h) => (
            <li key={h.code}>
              <button type="button" disabled={has(h.code)} onClick={() => onChange([...value, h])}>
                <b className="mono">{h.code}</b> {h.name} {has(h.code) ? '✓' : '+'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

export default App
