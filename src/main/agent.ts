import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import mysql from 'mysql2/promise'
import pg from 'pg'
import type { Conn, Icd, Settings } from '../preload/types'

export const PORT = 5000

// ICD10 → รหัสโรคของ dc (c_disease506 ที่ must_report) — แค่ช่วยเติมให้ รหัสอื่นที่ตั้งเพิ่มไม่มีก็ได้
// เพราะเว็บ dc จับคู่โรคจาก diag_code เทียบ icd10 ของโรคเองอยู่แล้ว (toPrefill)
export const DISEASES: Record<string, string> = {
  A90: '66',
  A91: '26',
  A911: '26',
  A919: '26',
  A910: '27',
  A920: '87',
  A925: '84'
}

// รหัสที่ผู้ใช้ตั้งมาจากหน้าโปรแกรม — ส่งเป็นพารามิเตอร์ ไม่ต่อสตริงเข้า SQL
export const ICD_RE = /^[A-Z][0-9A-Z]{1,6}$/
const marks = (n: number): string => Array(n).fill('?').join(',')

// เขียนให้รันได้ทั้ง MySQL/MariaDB และ PostgreSQL — จัดรูปวันที่/เวลาใน JS ไม่ใช้ฟังก์ชันเฉพาะของแต่ละ DB
// ไม่ใช้ window function (row_number() over) — HOSxP หลายแห่งยังเป็น MySQL 5.x / MariaDB < 10.2 ที่ไม่รองรับ
// จึงดึงแถวที่เข้าเกณฑ์ทั้งหมด แล้วเลือกแถวใน JS (pickRows)
// OPD: dx อยู่ที่ ovstdiag (key vn) · IPD: dx จำหน่ายอยู่ที่ iptdiag (key an) ต่อกลับหา vn ผ่าน ipt.vn
// ประเภทจำหน่าย: IPD = ipt.dchtype (dchtype) · OPD = ovst.ovstost (ovstost)
const sqlFor = (n: number): string => `
select
  case when d.src = 1 or o.an > '' then 'IPD' else 'OPD' end as patient_type,
  d.icd10, i.name as diag_name, coalesce(d.an, nullif(o.an, '')) as an, d.vn, d.hn, p.cid,
  case when a.an is not null then coalesce(dt.name, 'ยังไม่จำหน่าย') else os.name end as discharge_type,
  case p.sex when '1' then 'M' when '2' then 'F' end as gender,
  p.pname, p.fname, p.lname, v.age_y, v.age_m,
  coalesce(nullif(p.mobile_phone_number, ''), p.hometel) as tel,
  sc.cc_begin_date, d.dx_date, d.dx_time,
  p.addrpart as addr_no, p.road as addr_road,
  concat(p.chwpart, p.amppart, p.tmbpart, lpad(coalesce(p.moopart, '0'), 2, '0')) as area_code,
  sc.cc, sc.hpi,
  p.informname as kin_name, p.informtel as kin_tel, p.informrelation as kin_relation,
  d.src, d.diagtype
from (
  select 1 as src, t.an, t.vn, t.hn, x.icd10, x.diagtype, t.regdate as dx_date, t.regtime as dx_time
  from iptdiag x join ipt t on t.an = x.an
  where x.icd10 in (${marks(n)}) and t.regdate between ? and ?
  union all
  select 2, null, x.vn, x.hn, x.icd10, x.diagtype, x.vstdate, x.vsttime
  from ovstdiag x
  where x.icd10 in (${marks(n)}) and x.vstdate between ? and ?
) d
join patient p         on p.hn = d.hn
left join icd101 i     on i.code = d.icd10
left join ovst o       on o.vn = d.vn
left join vn_stat v    on v.vn = d.vn
left join opdscreen sc on sc.vn = d.vn
left join ipt a        on a.an = coalesce(d.an, nullif(o.an, ''))
left join dchtype dt   on dt.dchtype = a.dchtype
left join ovstost os   on os.ovstost = o.ovstost`

type Row = Record<string, unknown>
const t = (v: unknown): string => (v == null ? '' : String(v))

/**
 * เลือกแถว (แทน window function):
 * 1. visit เดียวเจอหลายแถว → IPD ก่อน (src 1) แล้ว diagtype ต่ำสุด (1 = principal) แล้วรหัสน้อยสุด
 * 2. คนเดียววันเดียวมาหลาย visit → visit สุดท้าย (เวลาล่าสุด แล้ว vn มากสุด)
 * เรียงผลใหม่สุดก่อน
 */
export function pickRows(rows: Row[]): Row[] {
  const byVn = new Map<string, Row>()
  const rank = (r: Row): string => `${t(r.src)}|${t(r.diagtype).padStart(3, '0')}|${t(r.icd10)}`
  for (const r of rows) {
    const b = byVn.get(t(r.vn))
    if (!b || rank(r) < rank(b)) byVn.set(t(r.vn), r)
  }
  const byDay = new Map<string, Row>()
  const late = (r: Row): string => `${t(r.dx_time)}|${t(r.vn)}`
  for (const r of byVn.values()) {
    const k = `${t(r.hn)}|${t(r.dx_date).slice(0, 10)}`
    const b = byDay.get(k)
    if (!b || late(r) > late(b)) byDay.set(k, r)
  }
  return [...byDay.values()].sort((a, b) =>
    `${t(b.dx_date).slice(0, 10)} ${t(b.dx_time)}`.localeCompare(`${t(a.dx_date).slice(0, 10)} ${t(a.dx_time)}`))
}

// DATE/TIMESTAMP ของ pg ให้คืนเป็นสตริง ไม่งั้นโดนแปลง timezone เลื่อนวัน
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (v) => v)

// ponytail: เปิด-ปิด connection ทุกคำขอ — คนเรียกคือเว็บเครื่องเดียว ใช้ pool เมื่อมีคนเรียกถี่
async function query(c: Conn, sql: string, params: string[] = []): Promise<Record<string, unknown>[]> {
  const opt = { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database }
  if (c.engine === 'mysql') {
    const db = await mysql.createConnection({ ...opt, dateStrings: true, charset: 'utf8mb4', connectTimeout: 5000 })
    try {
      const [rows] = await db.query(sql, params)
      return rows as Record<string, unknown>[]
    } finally {
      await db.end()
    }
  }
  let n = 0
  const db = new pg.Client({ ...opt, connectionTimeoutMillis: 5000 })
  await db.connect()
  try {
    return (await db.query(sql.replace(/\?/g, () => `$${++n}`), params)).rows
  } finally {
    await db.end()
  }
}

/** ต่อได้ และเป็นฐาน HOSxP (มีตารางที่คิวรีใช้) */
export async function testConn(c: Conn): Promise<string> {
  await query(c, 'select 1 from ovstdiag where 1 = 0')
  return `เชื่อมต่อ ${c.engine} ${c.host}:${c.port}/${c.database} สำเร็จ`
}

const str = (v: unknown): string | undefined => (v == null || v === '' ? undefined : String(v))
const num = (v: unknown): number | undefined => (v == null || v === '' ? undefined : Number(v))

type Lab = { item: string; at: string; line: string }

// ช่อง CSV (RFC 4180): มี , " หรือขึ้นบรรทัด ต้องครอบด้วย " และ " ข้างในเป็น "" — ผล lab อย่าง 66,000 มี , เสมอ
export const csv = (v?: string): string => (v == null ? '' : /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

// yyyy-mm-dd → 01ม.ค.69 (พ.ศ. 2 หลัก) — th-TH ของ Intl ใช้ปีพุทธศักราชอยู่แล้ว
const thFmt = new Intl.DateTimeFormat('th-TH', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' })
export const thDate = (iso?: string): string | undefined =>
  iso &&
  thFmt
    .formatToParts(new Date(`${iso.slice(0, 10)}T00:00:00Z`))
    .filter((p) => p.type !== 'literal')
    .map((p) => p.value)
    .join('')

// yyyy-mm-dd + n วัน (คิดแบบ UTC ไม่โดน DST/timezone ของเครื่อง)
export const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

/** ช่วงวันที่ของ lab ที่นับให้เคส: วันรับบริการ ถึง +7 วัน (รวมนัดเจาะเลือดซ้ำ/ระหว่างนอน) */
export const LAB_DAYS = 7

/**
 * lab ทุกรายการที่มีผลของคนไข้ที่ให้มา ในช่วง from ถึง to+LAB_DAYS — คีย์ = hn
 * เลือกด้วย hn ไม่ใช่ vn/an: นัดมาเจาะเลือดดูเกล็ดเลือดเป็นคนละ visit แต่เป็นการป่วยครั้งเดียวกัน
 * line = แถว CSV "01ม.ค.69,ชื่อ,ผล" · at (วัน-เวลาสั่ง) ใช้กรองช่วง/เรียง/หาผลล่าสุด ไม่ได้แสดง
 * ยิงแยกคิวรีเดียวทั้งก้อน ไม่ group_concat ในคิวรีหลัก: MySQL ตัดที่ 1024 ตัวอักษร และ pg ใช้ string_agg คนละชื่อ
 */
async function labs(c: Conn, hns: string[], from: string, to: string): Promise<Map<string, Lab[]>> {
  const m = new Map<string, Lab[]>()
  if (!hns.length) return m
  const rows = await query(
    c,
    `select h.hn, h.order_date, h.order_time, o.lab_items_code, li.lab_items_name, o.lab_order_result
     from lab_head h
     join lab_order o  on o.lab_order_number = h.lab_order_number
     join lab_items li on li.lab_items_code = o.lab_items_code
     where h.hn in (${hns.map(() => '?').join(',')}) and h.order_date between ? and ? and o.lab_order_result > ''
     order by h.order_date, h.order_time, h.lab_order_number, li.display_order, li.lab_items_code`,
    [...hns, from, addDays(to, LAB_DAYS)]
  )
  for (const r of rows) {
    const at = [str(r.order_date)?.slice(0, 10), str(r.order_time)?.slice(0, 5)].filter(Boolean).join(' ')
    const line = [thDate(str(r.order_date)), str(r.lab_items_name)?.trim(), str(r.lab_order_result)?.trim()]
      .map(csv)
      .join(',')
    const k = String(r.hn)
    m.set(k, [...(m.get(k) ?? []), { item: String(r.lab_items_code), at, line }])
  }
  return m
}

/** ผลล่าสุดของแต่ละรายการ — ลบแล้วใส่ใหม่ให้ Map ย้ายไปท้าย ลำดับสุดท้ายจึงเรียงตามเวลาของผลล่าสุด */
function lastPerItem(all: Lab[]): string[] {
  const last = new Map<string, Lab>()
  for (const l of [...all].sort((a, b) => a.at.localeCompare(b.at))) {
    last.delete(l.item)
    last.set(l.item, l)
  }
  return [...last.values()].map((l) => l.line)
}

/** ค้นรหัสโรคจาก icd101 ของ HIS — พิมพ์รหัส (มีจุดก็ได้) หรือชื่อภาษาอังกฤษ */
export async function searchIcd(c: Conn, q: string): Promise<Icd[]> {
  const t = q.trim().toUpperCase()
  if (!t) return []
  const rows = await query(
    c,
    'select code, name from icd101 where upper(code) like ? or upper(name) like ? order by code limit 30',
    [`${t.replace(/[.\s]/g, '')}%`, `%${t}%`]
  )
  return rows.map((r) => ({ code: String(r.code), name: str(r.name) ?? '' }))
}

/** แถวตามสัญญา HisPatient ของเว็บ dc + ช่องอื่นของฟอร์มแจ้งเคส */
export async function patients(c: Conn, from: string, to: string, icd: string[]): Promise<Record<string, unknown>[]> {
  const codes = icd.filter((x) => ICD_RE.test(x))
  if (!codes.length) return []   // ไม่ได้เลือกรหัส = ไม่มีคนไข้ (และ in () ว่างเป็น SQL ผิด)
  const rows = pickRows(await query(c, sqlFor(codes.length), [...codes, from, to, ...codes, from, to]))
  const lab = await labs(c, [...new Set(rows.map((r) => String(r.hn)))], from, to)
  return rows.map((r) => {
    const dx = str(r.dx_date)?.slice(0, 10)
    // lab ของคนนี้ตั้งแต่วันรับบริการถึง +7 วัน แล้วเหลือผลล่าสุดของแต่ละรายการ
    const end = dx && addDays(dx, LAB_DAYS)
    const lines = dx ? lastPerItem((lab.get(String(r.hn)) ?? []).filter((l) => l.at >= dx && l.at.slice(0, 10) <= end!)) : []
    return {
      // แถว CSV วดป,lab_item,lab_result — ไม่มีแถวหัวคอลัมน์ (เว็บ dc ใส่ลงช่องผล lab ตรง ๆ)
      lab_result: lines.join('\n') || undefined,
      patient_type: r.patient_type,
      disease_code: DISEASES[String(r.icd10)],
      diag_code: r.icd10,
      diag_name: str(r.diag_name),
      an: str(r.an),
      discharge_type: str(r.discharge_type),
      vn: str(r.vn),
      hn: str(r.hn),
      cid: str(r.cid),
      pname: str(r.pname),
      fname: str(r.fname),
      lname: str(r.lname),
      gender: str(r.gender),
      age_y: num(r.age_y),
      age_m: num(r.age_m),
      tel: str(r.tel),
      // ไม่มีวันเริ่มมีอาการใน HIS = ว่าง ให้ผู้แจ้งกรอกเอง — ไม่เดาเป็นวันที่มา (ปีระบาดนับตามวันเริ่มป่วย)
      date_onset: str(r.cc_begin_date)?.slice(0, 10),
      date_visit: dx,
      date_dx: dx,
      time_dx: str(r.dx_time)?.slice(0, 5),
      addr_no: str(r.addr_no),
      addr_road: str(r.addr_road),
      area_code: str(r.area_code),
      // แยกหัวข้อ CC/PI ให้อ่านง่าย — ช่องไหนว่างไม่ต้องขึ้นหัวข้อ
      symptom:
        [
          ['CC', str(r.cc)?.trim()],
          ['PI', str(r.hpi)?.trim()]
        ]
          .filter(([, v]) => v)
          .map(([k, v]) => `${k} : ${v}`)
          .join('\n') || undefined,
      kin_name: str(r.kin_name),
      kin_tel: str(r.kin_tel),
      kin_relation: str(r.kin_relation)
    }
  })
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
// เทียบผ่าน hash ให้ยาวเท่ากันเสมอ timingSafeEqual ถึงใช้ได้ — กันเดา token ทีละตัวจากเวลาตอบ
const sha = (v: string): Buffer => createHash('sha256').update(v).digest()
const tokenOk = (auth: string | undefined, token: string): boolean =>
  !!token && timingSafeEqual(sha(auth ?? ''), sha(`Bearer ${token}`))
let server: http.Server | null = null

export function start(get: () => Settings, log: (m: string) => void): Promise<void> {
  const srv = http.createServer(async (req, res) => {
    const s = get()
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    // ข้อมูลคนไข้ — ให้เฉพาะเว็บที่ระบุ ไม่ใช่ * ไม่งั้นเว็บไหนที่เปิดในเครื่องนี้ก็อ่านได้
    // ไม่มี Origin = เปิดตรงจากแถบที่อยู่/curl บนเครื่องนี้เอง
    const origin = req.headers.origin
    if (origin) {
      const allowed = s.origins.split(',').map((o) => o.trim().replace(/\/$/, ''))
      if (!allowed.includes(origin)) {
        log(`ปฏิเสธ ${origin}`)
        return send(403, { error: 'origin not allowed' })
      }
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization')
      res.setHeader('Access-Control-Allow-Private-Network', 'true') // เว็บ https เรียก localhost
      res.writeHead(204).end()
      return
    }
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' })

    if (url.pathname === '/health') {
      return send(200, { status: 'ok', engine: s.conn.engine, database: s.conn.database, from: s.from, to: s.to })
    }
    if (url.pathname === '/patients') {
      if (!tokenOk(req.headers.authorization, s.token)) {
        log('GET /patients ปฏิเสธ: token ไม่ถูกต้อง')
        return send(401, { error: 'invalid token' })
      }
      // ?from=&to= ทับช่วงที่ตั้งไว้ในโปรแกรมได้
      const from = url.searchParams.get('from') ?? s.from
      const to = url.searchParams.get('to') ?? s.to
      if (!DATE.test(from) || !DATE.test(to)) return send(400, { error: 'from/to ต้องเป็น yyyy-mm-dd' })
      try {
        const rows = await patients(s.conn, from, to, s.icd10.map((i) => i.code))
        log(`GET /patients ${from} ถึง ${to} → ${rows.length} ราย`)
        return send(200, rows)
      } catch (e) {
        log(`GET /patients ผิดพลาด: ${(e as Error).message}`)
        return send(500, { error: (e as Error).message })
      }
    }
    send(404, { error: 'not found' })
  })

  return new Promise((resolve, reject) => {
    srv.once('error', reject) // เช่น EADDRINUSE พอร์ตมีโปรแกรมอื่นใช้อยู่
    // 127.0.0.1 เท่านั้น — เครื่องอื่นในวงแลนเข้าไม่ได้
    srv.listen(PORT, '127.0.0.1', () => {
      server = srv
      resolve()
    })
  })
}

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve()
    server.closeAllConnections()
    server.close(() => resolve())
    server = null
  })
}
