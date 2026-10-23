import http from 'node:http'
import { networkInterfaces } from 'node:os'
import { createHash, timingSafeEqual } from 'node:crypto'
import mysql from 'mysql2/promise'
import pg from 'pg'
import type { Conn, Icd, Result, Settings } from '../preload/types'

/** พอร์ตตั้งต้น — เปลี่ยนได้ในโปรแกรม (Settings.port) */
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

/** ผลค้นสูงสุดต่อครั้ง — เว็บ dc บอกให้พิมพ์ละเอียดขึ้นเมื่อได้ครบจำนวนนี้ (HIS_MAX ใน src/lib/his.ts) */
export const MAX_ROWS = 50

// เขียนให้รันได้ทั้ง MySQL/MariaDB และ PostgreSQL — จัดรูปวันที่/เวลาใน JS ไม่ใช้ฟังก์ชันเฉพาะของแต่ละ DB
// ไม่ใช้ window function (row_number() over) — HOSxP หลายแห่งยังเป็น MySQL 5.x / MariaDB < 10.2 ที่ไม่รองรับ
// จึงดึงแถวทั้งหมด แล้วเลือกแถวใน JS (pickRows)
// ตั้งต้นจาก visit (ovst / ipt) แล้ว left join dx — /patients ค้นชื่อจึงเจอคนที่หมอยังไม่ลงรหัสด้วย · /patients/scope กรอง visit ด้วยรหัสที่ตั้งไว้
// OPD: dx อยู่ที่ ovstdiag (key vn) · IPD: dx จำหน่ายอยู่ที่ iptdiag (key an) ต่อกลับหา vn ผ่าน ipt.vn
// ประเภทจำหน่าย: IPD = ipt.dchtype (dchtype) · OPD = ovst.ovstost (ovstost)
// ipd/opd = เงื่อนไขเพิ่มของ visit (ต่อท้ายช่วงวันที่) · where = เงื่อนไขท้ายคิวรี (ค้นชื่อ)
// เก็บ dx ทุกตัวของ visit ที่ผ่าน ไม่ใช่เฉพาะตัวที่ตรง — diags จะได้ครบ
const sqlFor = (ipd: string, opd: string, where: string): string => `
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
  from ipt t left join iptdiag x on x.an = t.an
  where t.regdate between ? and ?${ipd}
  union all
  select 2, null, v.vn, v.hn, x.icd10, x.diagtype, v.vstdate, v.vsttime
  from ovst v left join ovstdiag x on x.vn = v.vn
  where v.vstdate between ? and ?${opd}
) d
join patient p         on p.hn = d.hn
left join icd101 i     on i.code = d.icd10
left join ovst o       on o.vn = d.vn
left join vn_stat v    on v.vn = d.vn
left join opdscreen sc on sc.vn = d.vn
left join ipt a        on a.an = coalesce(d.an, nullif(o.an, ''))
left join dchtype dt   on dt.dchtype = a.dchtype
left join ovstost os   on os.ovstost = o.ovstost
${where}`

type Row = Record<string, unknown>
const t = (v: unknown): string => (v == null ? '' : String(v))

/**
 * เลือกแถว (แทน window function): 1 visit = 1 แถว
 * แถวที่มีรหัสโรคก่อน (IPD ที่ยังไม่ลง iptdiag ต้องไม่ทับ dx ของ OPD visit เดียวกัน)
 * แล้ว IPD ก่อน (src 1) แล้ว diagtype ต่ำสุด (1 = principal) แล้วรหัสน้อยสุด
 * คนเดียวหลาย visit แสดงทุก visit — ผู้ใช้ค้นด้วยชื่อแล้วเลือก visit ที่ใช่เอง · เรียงใหม่สุดก่อน
 * diags = ทุกรหัสของ visit นั้น (1 visit วินิจฉัยได้หลายโรค) เฉพาะที่ขึ้นต้นด้วยอักษรอังกฤษ A–Y
 * ไม่เอา Z (รหัสบริการ/ปัจจัย ไม่ใช่โรค) และรหัสที่ขึ้นต้นด้วยตัวเลข/อักษรอื่น (หัตถการ ICD9 ฯลฯ)
 * เรียงตาม diagtype (1 principal, 2 comorbidity, 3 complication, …) แล้ว IPD ก่อน แล้วรหัส · รหัสเดียวกันที่ลงทั้ง OPD และ IPD เหลือตัวเดียว (ตัวที่ diagtype ต่ำสุด)
 */
export function pickRows(rows: Row[]): Row[] {
  const byVn = new Map<string, Row>()
  const dxOf = new Map<string, Row[]>()
  const rank = (r: Row): string => `${r.icd10 ? 0 : 1}|${t(r.src)}|${t(r.diagtype).padStart(3, '0')}|${t(r.icd10)}`
  for (const r of rows) {
    const k = t(r.vn)
    const b = byVn.get(k)
    if (!b || rank(r) < rank(b)) byVn.set(k, r)
    if (/^[A-Y]/i.test(t(r.icd10))) dxOf.set(k, [...(dxOf.get(k) ?? []), r])
  }
  const diags = (k: string): { code: string; name?: string }[] => {
    const m = new Map<string, string | undefined>()
    const byType = (r: Row): string => `${t(r.diagtype).padStart(3, '0')}|${t(r.src)}|${t(r.icd10)}`
    for (const r of (dxOf.get(k) ?? []).sort((a, b) => byType(a).localeCompare(byType(b))))
      if (!m.has(t(r.icd10))) m.set(t(r.icd10), r.diag_name == null ? undefined : String(r.diag_name))
    return [...m].map(([code, name]) => ({ code, name }))
  }
  return [...byVn.entries()].map(([k, r]): Row => ({ ...r, diags: diags(k) })).sort((a, b) =>
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

/** วันนี้ (+d วัน) ตามเวลาเครื่อง yyyy-mm-dd */
export const today = (d = 0): string => {
  const t = new Date(Date.now() + d * 86400000)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/** ช่วงวันที่ของ lab ที่นับให้เคส: วันรับบริการ ถึง +7 วัน (รวมนัดเจาะเลือดซ้ำ/ระหว่างนอน) */
export const LAB_DAYS = 7

/**
 * lab ทุกรายการที่มีผลของคนไข้ที่ให้มา ในช่วง from ถึง to+LAB_DAYS — คีย์ = hn
 * เลือกด้วย hn ไม่ใช่ vn/an: นัดมาเจาะเลือดดูเกล็ดเลือดเป็นคนละ visit แต่เป็นการป่วยครั้งเดียวกัน
 * line = แถว CSV "01ม.ค.69,ชื่อ,ผล" · at (วัน-เวลาสั่ง) ใช้กรองช่วง/เรียง/หาผลล่าสุด ไม่ได้แสดง
 * ยิงแยกคิวรีเดียวทั้งก้อน ไม่ group_concat ในคิวรีหลัก: MySQL ตัดที่ 1024 ตัวอักษร และ pg ใช้ string_agg คนละชื่อ
 */
async function labs(c: Conn, hns: string[], from: string, to: string): Promise<Map<string, Lab[]>> {
  if (!hns.length) return new Map()
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
  return labMap(rows)
}

/** แถว lab ตามผลคิวรี → คีย์ = hn (ของจริงและโหมดสาธิตใช้ตัวเดียวกัน) */
function labMap(rows: Row[]): Map<string, Lab[]> {
  const m = new Map<string, Lab[]>()
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

/** /patients — ค้นด้วยชื่อ/สกุล ทุก visit ไม่กรองรหัสโรค */
// เหลือแค่ไทย + ASCII — ฐาน HOSxP หลายแห่งเป็น tis620 ตัวอื่น (emoji, é) ทำ like พัง "Illegal mix of collations"
const wordsOf = (name: string): string[] =>
  name.replace(/[^฀-๿\x21-\x7E]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 3)

export async function patients(c: Conn, from: string, to: string, name: string): Promise<Record<string, unknown>[]> {
  const words = wordsOf(name)
  if (!words.length) return []   // ไม่มีชื่อ = ไม่ส่งรายชื่อคนไข้ทั้งวันออกไป
  const like = words.flatMap((w) => [`%${w}%`, `%${w}%`])
  // ทุกคำต้องเจอในชื่อหรือสกุล (พิมพ์ "สมชาย ใจดี" ได้)
  const where = `where ${words.map(() => '(p.fname like ? or p.lname like ?)').join(' and ')}`
  // พิมพ์สั้น ๆ อย่าง "สม" เจอเป็นร้อย — ตัดที่ MAX_ROWS (ใหม่สุดก่อน) ให้พิมพ์ละเอียดขึ้นแทน
  const rows = pickRows(await query(c, sqlFor('', '', where), [from, to, from, to, ...like])).slice(0, MAX_ROWS)
  return shape(rows, await labs(c, hnsOf(rows), from, to))
}

/**
 * /patients/scope — visit ที่มี dx ตัวใดตัวหนึ่งอยู่ในรหัสที่ตั้งไว้ (แท็บข้อมูลที่ดึง) ไม่ต้องใส่ชื่อ
 * ไม่ตัดที่ MAX_ROWS: เป็นรายการเคสที่ต้องรายงาน ตัดทิ้งเงียบ ๆ ไม่ได้ · จำนวนจำกัดอยู่แล้วด้วยรหัสกับวันเดียว
 * o.labs false = ไม่ยิงคิวรี lab (ตัวแจ้งเตือนไม่ใช้ผล lab)
 */
export async function scopePatients(c: Conn, day: string, icd: string[], o: { labs?: boolean } = {}): Promise<Record<string, unknown>[]> {
  const codes = icd.filter((x) => ICD_RE.test(x))
  if (!codes.length) return []   // ไม่ได้เลือกรหัส = ไม่มีคนไข้ (และ in () ว่างเป็น SQL ผิด)
  const marks = codes.map(() => '?').join(',')
  // visit ที่ตรง = มีรหัสใน ovstdiag หรือ iptdiag ตัวใดตัวหนึ่ง — กรองทั้งสองฝั่งด้วยเงื่อนไขเดียวกัน
  // ไม่งั้น visit ที่รหัสตรงอยู่ฝั่ง IPD จะหลุด dx ฝั่ง OPD (และกลับกัน) diags ไม่ครบ
  // exists ผูก vn ของแถวนอก (กรองวันแล้ว) → ค้นด้วย index vn เฉพาะ visit วันนั้น
  // ไม่ใช่ in (select vn ... where icd10 in) ที่ดึง vn ทุกปีของรหัสนั้นมาก่อน · ผลเท่าเดิม (in = or ของ exists)
  const hit = ` and (exists (select 1 from ovstdiag q where q.vn = %s and q.icd10 in (${marks}))
    or exists (select 1 from ipt y join iptdiag z on z.an = y.an where y.vn = %s and z.icd10 in (${marks})))`
  const sql = sqlFor(hit.replace(/%s/g, 't.vn'), hit.replace(/%s/g, 'v.vn'), '')
  const rows = pickRows(await query(c, sql, [day, day, ...codes, ...codes, day, day, ...codes, ...codes]))
  return shape(rows, o.labs === false ? new Map() : await labs(c, hnsOf(rows), day, day))
}

const hnsOf = (rows: Row[]): string[] => [...new Set(rows.map((r) => String(r.hn)))]

/** แถวตามสัญญา HisPatient ของเว็บ dc + ช่องอื่นของฟอร์มแจ้งเคส */
function shape(rows: Row[], lab: Map<string, Lab[]>): Record<string, unknown>[] {
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
      diags: r.diags,
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

/**
 * โหมดสาธิต — ไม่ต่อ HOSxP: คนไข้ปลอม 3 ราย (DHF A91 นอน รพ. · DF A90 · Zika A925) มาวันนี้ สกุล "ทดสอบ" ทุกคน
 * เป็นแถวแบบผลคิวรีจริง (sqlFor / labs) แล้วผ่าน pickRows → labMap → shape ชุดเดียวกับของจริง
 */
function demo(): { rows: Row[]; lab: Row[] } {
  const d = today()
  const yy = String(Number(d.slice(0, 4)) + 543).slice(2)   // vn/an ของ HOSxP ขึ้นต้นด้วยปี พ.ศ. 2 หลัก
  const vn = (hm: string): string => `${yy}${d.slice(5, 7)}${d.slice(8, 10)}${hm}00`
  const p = { dx_date: d, addr_road: '', lname: 'ทดสอบ', src: 2, diagtype: '1', patient_type: 'OPD', discharge_type: 'กลับบ้าน' }
  const dhf = {
    ...p, src: 1, patient_type: 'IPD', discharge_type: 'ยังไม่จำหน่าย', an: `${yy}0004321`, vn: vn('0815'), hn: '000910001',
    cid: '1659900000011', gender: 'M', pname: 'ด.ช.', fname: 'ก้องภพ', age_y: 12, age_m: 3, tel: '0810000001',
    cc_begin_date: today(-4), dx_time: '08:15:00', addr_no: '12/1', area_code: '65010102',
    cc: 'ไข้สูง 4 วัน ปวดศีรษะ อาเจียน', hpi: '4 วันก่อนมา ไข้สูงลอย ปวดเมื่อยตัว วันนี้ซึมลง มีจุดเลือดออกที่แขน tourniquet test positive',
    kin_name: 'นางสมศรี ทดสอบ', kin_tel: '0810000011', kin_relation: 'มารดา'
  }
  const rows: Row[] = [
    { ...dhf, icd10: 'A91', diag_name: 'Dengue haemorrhagic fever' },
    { ...dhf, icd10: 'E86', diag_name: 'Volume depletion', diagtype: '2' },
    {
      ...p, icd10: 'A90', diag_name: 'Dengue fever [classical dengue]', vn: vn('0930'), hn: '000910002',
      cid: '3659900000022', gender: 'F', pname: 'นาง', fname: 'มาลี', age_y: 34, age_m: 7, tel: '0810000002',
      cc_begin_date: today(-3), dx_time: '09:30:00', addr_no: '45', area_code: '65050304',
      cc: 'ไข้ 3 วัน ปวดกระบอกตา ปวดเมื่อยกล้ามเนื้อ', hpi: '3 วันก่อนมา มีไข้ ปวดศีรษะ ปวดกระบอกตา เบื่ออาหาร ไม่มีเลือดออก',
      kin_name: 'นายสมพงษ์ ทดสอบ', kin_tel: '0810000022', kin_relation: 'สามี'
    },
    {
      ...p, icd10: 'A925', diag_name: 'Zika virus disease', vn: vn('1045'), hn: '000910003',
      cid: '1659900000033', gender: 'F', pname: 'นางสาว', fname: 'วันดี', age_y: 27, age_m: 1, tel: '0810000003',
      cc_begin_date: today(-2), dx_time: '10:45:00', addr_no: '7/3', area_code: '65030201',
      cc: 'ไข้ต่ำ ผื่นแดง ตาแดง 2 วัน', hpi: '2 วันก่อนมา มีไข้ต่ำ ๆ ผื่นแดงที่ลำตัว ตาแดงไม่มีขี้ตา ปวดข้อมือ ตั้งครรภ์ 12 สัปดาห์',
      kin_name: 'นายวิชัย ทดสอบ', kin_tel: '0810000033', kin_relation: 'บิดา'
    }
  ]
  const l = (hn: string, at: string, code: string, item: string, v: string): Row =>
    ({ hn, order_date: d, order_time: `${at}:00`, lab_items_code: code, lab_items_name: item, lab_order_result: v })
  const lab = [
    l('000910001', '08:40', '481', 'Platelet count', '45,000'),
    l('000910001', '08:40', '482', 'Hct', '48'),
    l('000910001', '08:40', '901', 'Dengue NS1 Ag', 'Positive'),
    l('000910001', '14:00', '481', 'Platelet count', '38,000'),   // ผลล่าสุดทับผลเช้า
    l('000910002', '09:50', '481', 'Platelet count', '120,000'),
    l('000910002', '09:50', '482', 'Hct', '40'),
    l('000910002', '09:50', '902', 'Dengue IgM', 'Positive'),
    l('000910003', '11:05', '481', 'Platelet count', '210,000'),
    l('000910003', '11:05', '903', 'Zika virus RT-PCR', 'Detected')
  ]
  return { rows, lab }
}

/** /patients โหมดสาธิต — กรองวันที่และชื่อแบบเดียวกับคิวรีจริง */
export function demoPatients(from: string, to: string, name: string): Record<string, unknown>[] {
  const words = wordsOf(name).map((w) => w.toLowerCase())
  const d = today()
  if (!words.length || d < from || d > to) return []
  const { rows, lab } = demo()
  const hit = rows.filter((r) => words.every((w) => [r.fname, r.lname].some((v) => t(v).toLowerCase().includes(w))))
  return shape(pickRows(hit), labMap(lab))
}

/** /patients/scope โหมดสาธิต — visit ที่มีรหัสใดรหัสหนึ่งตรง (dx ทุกตัวของ visit นั้นมาด้วย) */
export function demoScope(day: string, icd: string[], o: { labs?: boolean } = {}): Record<string, unknown>[] {
  if (day !== today()) return []
  const { rows, lab } = demo()
  const vns = new Set(rows.filter((r) => icd.includes(t(r.icd10))).map((r) => r.vn))
  return shape(pickRows(rows.filter((r) => vns.has(r.vn))), labMap(o.labs === false ? [] : lab))
}

/** คนไข้ของวันตามรหัส — /patients/scope กับตัวแจ้งเตือนใช้ทางเดียวกัน (DEMO หรือ HOSxP) */
const scope = async (s: Settings, day: string, codes: string[], o: { labs?: boolean } = {}): Promise<Record<string, unknown>[]> =>
  s.demo ? demoScope(day, codes, o) : scopePatients(s.conn, day, codes, o)

// MOPH Alert v3.1 — แบบเดียวกับ dc (src/lib/moph-alert.ts) ส่งเข้าไลน์หมอพร้อมตามเลขบัตรประชาชน
const MOPH_URL = 'https://morpromt2c.moph.go.th/alert/v3.1/messages'

/** ยิงจริง — throw เมื่อไม่สำเร็จ · ข้อความ error ปิดเลข 13 หลัก (response อาจมีเลขบัตรผู้รับ) */
export async function mophPost(key: string, secret: string, body: unknown): Promise<void> {
  const r = await fetch(MOPH_URL, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', 'client-key': key, 'secret-key': secret },
    body: JSON.stringify(body)
  })
  const t = await r.text()
  if (!r.ok || !/"message_code"\s*:\s*200/.test(t)) throw new Error(`MOPH Alert ตอบ ${r.status} ${t.replace(/\d{13}/g, '***').slice(0, 200)}`)
}

const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** dx ที่ตรงรหัสที่ตั้งไว้ของแถวคนไข้ (จาก diags ก่อน แล้ว diag_code) — ชื่อโรคไม่มีใน HIS ใช้ชื่อจากรายการรหัสที่ตั้งไว้ */
export function matchDx(p: Record<string, unknown>, icd10: Icd[]): { code: string; name: string } {
  const set = new Set(icd10.map((i) => i.code))
  const diags = (Array.isArray(p.diags) ? p.diags : []) as { code: string; name?: string }[]
  const d = diags.find((x) => set.has(x.code)) ?? { code: t(p.diag_code), name: t(p.diag_name) }
  return { code: d.code, name: d.name || icd10.find((i) => i.code === d.code)?.name || '' }
}

/**
 * payload "พบการวินิจฉัยโรคตามรหัสที่ท่านตั้งไว้" — 1 ข้อความต่อคนไข้ · หัว/รูปแบบแบบเดียวกับ dxFoundAlert + payload() ของ dc
 * เนื้อหา: วัน-เวลา dx / รหัส - ชื่อโรค / ชื่อ-นามสกุล · ไม่มีปุ่ม · p = แถวจาก scope (date_dx yyyy-mm-dd, time_dx HH:mm)
 */
export function dxFoundMsg(p: Record<string, unknown>, dx: { code: string; name: string }, cid: string, at = new Date()): Record<string, unknown> {
  const d = new Date(`${t(p.date_dx)}T00:00:00`).toLocaleDateString('th-TH', { dateStyle: 'medium' })
  const when = p.time_dx ? `${d}-${t(p.time_dx)}` : d
  const title = 'พบการวินิจฉัยโรคตามรหัสที่ท่านตั้งไว้'
  const lines = [
    `วัน-เวลา : ${when}`,
    `มีการบันทึกการวินิจฉัย ${dx.code} - ${dx.name} ใน HOSXP`,
    `${t(p.pname)}${t(p.fname)} ${t(p.lname)}`.trim()
  ]
  const flex = {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#B45309', paddingAll: 'md',
      contents: [
        { type: 'text', text: 'DcSync', color: '#FFFFFF', size: 'xs', weight: 'bold' },
        { type: 'text', text: title, color: '#FFFFFF', size: 'lg', weight: 'bold', wrap: true }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        ...lines.map((text) => ({ type: 'text', text, size: 'sm', color: '#333333', wrap: true })),
        { type: 'separator', margin: 'md' },
        { type: 'text', size: 'xs', color: '#999999', align: 'end', margin: 'md',
          text: at.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) }
      ]
    }
  }
  return {
    cid: [cid],
    messages: [{ type: 'flex', altText: `${title} — ${dx.code} ${dx.name}`.slice(0, 400), contents: flex }],
    message_title: title,
    message_html: `<strong>${title}</strong><br>${lines.map(esc).join('<br>')}`,
    message_text: `${title}\n${lines.join('\n')}`,
    message_type: 'HPT'
  }
}

/** คีย์ที่ส่งแล้ว `วันรับบริการ|hn|cid` → วันรับบริการ (ไว้ตัดของเก่า) — เก็บเป็นไฟล์ใน userData */
export type Sent = Record<string, string>
/** เก็บคีย์ที่ส่งแล้วกี่วัน — ใช้จริงแค่วันนี้ เก็บเผื่อเวลาเครื่องถอยหลัง */
export const SENT_DAYS = 3

export const maskCid = (c: string): string => `${c.slice(0, 1)}xxxxxxxx${c.slice(-4)}`

/**
 * ตรวจคนไข้วันนี้ที่ dx ตรงรหัสในแท็บข้อมูลที่ดึง → แจ้งผู้รับที่เปิดเตือนทุกคน เฉพาะคนไข้ที่ยังไม่เคยแจ้งผู้รับคนนั้น
 * กันซ้ำแบบ c_survillence_moph_alert_log ของ dc: 1 คนไข้ (hn) แจ้งผู้รับแต่ละคนได้วันละครั้ง (dx เปลี่ยน/เพิ่มก็ไม่แจ้งซ้ำ)
 * ส่ง 1 ข้อความต่อคนไข้ต่อผู้รับ · ลงคีย์หลังส่งสำเร็จเท่านั้น ไม่สำเร็จ = รอบหน้าส่งใหม่
 * แก้ sent ในที่ — คนเรียกเขียนลงไฟล์ · skip = ข้าม (ไม่มีผู้รับ) · ok false = ข้าม หรือมีผู้รับที่ส่งไม่สำเร็จ
 */
export async function checkAlerts(
  s: Settings, sent: Sent, post: (body: unknown) => Promise<void>, log: (m: string) => void, day = today()
): Promise<Result & { skip?: true }> {
  for (const [k, d] of Object.entries(sent)) if (d < addDays(day, -SENT_DAYS)) delete sent[k]
  const to = s.alerts.filter((a) => a.enabled)
  if (!to.length) return { ok: false, skip: true, message: 'แจ้งเตือน: ไม่มีผู้รับที่เปิดเตือน — ไม่ส่ง' }
  // 1 คนไข้ (hn) = 1 แถว — แถวแรกคือ visit ใหม่สุด · ข้อความไม่มีผล lab จึงไม่ดึง lab (รันทุก 5 นาที)
  const byHn = new Map<string, Record<string, unknown>>()
  for (const r of await scope(s, day, s.icd10.map((i) => i.code), { labs: false })) if (t(r.hn) && !byHn.has(t(r.hn))) byHn.set(t(r.hn), r)
  const tag = s.demo ? ' [DEMO]' : ''
  let sentN = 0
  let failed = 0
  for (const a of to) {
    for (const [hn, p] of byHn) {
      const key = `${day}|${hn}|${a.cid}`
      if (sent[key]) continue
      try {
        await post(dxFoundMsg(p, matchDx(p, s.icd10), a.cid))
        sent[key] = day
        sentN++
        log(`แจ้งเตือน ${a.name} (${maskCid(a.cid)}) 1 ราย${tag}`)
      } catch (e) {
        failed++
        log(`แจ้งเตือน ${a.name} (${maskCid(a.cid)}) ไม่สำเร็จ — ส่งใหม่รอบหน้า: ${(e as Error).message}`)
      }
    }
  }
  return {
    ok: !failed,
    message: `ตรงรหัส ${byHn.size} ราย · ส่งแล้ว ${sentN} ข้อความ${failed ? ` · ไม่สำเร็จ ${failed} ข้อความ` : ''}${tag}`
  }
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
    const url = new URL(req.url ?? '/', 'http://localhost')   // ใช้แค่แยก path/query
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
      // dx_code = รหัสที่ตั้งในแท็บข้อมูลที่ดึง — เว็บ dc ใช้เป็นค่าตั้งต้นของ "รหัสวินิจฉัยที่ต้องการดึง"
      // demo = โหมดสาธิต (ไม่ต่อ HOSxP) database จึงเป็น DEMO
      return send(200, { status: 'ok', engine: s.conn.engine, database: s.demo ? 'DEMO' : s.conn.database, from: s.from, to: s.to,
                         dx_code: s.icd10.map((i) => i.code), demo: s.demo })
    }
    if (url.pathname === '/patients/scope') {
      if (!tokenOk(req.headers.authorization, s.token)) {
        log('GET /patients/scope ปฏิเสธ: token ไม่ถูกต้อง')
        return send(401, { error: 'invalid token' })
      }
      // ?vstdate= วันรับบริการ (บังคับ) · ?dx_code= รหัสโรค array (ซ้ำหลายตัว หรือคั่น ,) ไม่ส่ง = ที่ตั้งในแท็บข้อมูลที่ดึง
      const day = url.searchParams.get('vstdate') ?? ''
      if (!DATE.test(day)) return send(400, { error: 'vstdate ต้องเป็น yyyy-mm-dd' })
      const asked = url.searchParams.getAll('dx_code').flatMap((v) => v.split(','))
        .map((v) => v.replace(/[.\s]/g, '').toUpperCase()).filter(Boolean)
      const codes = asked.length ? [...new Set(asked)].slice(0, 100) : s.icd10.map((i) => i.code)
      try {
        const rows = await scope(s, day, codes)
        log(`GET /patients/scope ${day} (${asked.length ? `${codes.length} รหัสจากเว็บ` : 'รหัสที่ตั้งไว้'}) → ${rows.length} ราย${s.demo ? ' [DEMO]' : ''}`)
        return send(200, rows)
      } catch (e) {
        log(`GET /patients/scope ผิดพลาด: ${(e as Error).message}`)
        return send(500, { error: (e as Error).message })
      }
    }
    if (url.pathname === '/patients') {
      if (!tokenOk(req.headers.authorization, s.token)) {
        log('GET /patients ปฏิเสธ: token ไม่ถูกต้อง')
        return send(401, { error: 'invalid token' })
      }
      // ?name= ค้นชื่อ/สกุล (บังคับ) · ?vstdate= = วันรับบริการวันเดียว · ?from=&to= ทับช่วงที่ตั้งไว้ในโปรแกรมได้
      const vstdate = url.searchParams.get('vstdate')
      const from = vstdate ?? url.searchParams.get('from') ?? s.from
      const to = vstdate ?? url.searchParams.get('to') ?? s.to
      const name = (url.searchParams.get('name') ?? '').slice(0, 100)
      if (!name.trim()) return send(400, { error: 'ต้องระบุ name' })
      if (!DATE.test(from) || !DATE.test(to)) return send(400, { error: 'วันที่ต้องเป็น yyyy-mm-dd' })
      try {
        const rows = s.demo ? demoPatients(from, to, name) : await patients(s.conn, from, to, name)
        // ไม่ลงชื่อที่ค้นในบันทึก — เป็นข้อมูลคนไข้
        log(`GET /patients ${from} ถึง ${to} (ค้นชื่อ) → ${rows.length} ราย${s.demo ? ' [DEMO]' : ''}`)
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
    // ทุก ip — เครื่องอื่นในวงแลนเรียกเครื่องนี้ได้ (ตั้ง URL ที่เว็บ dc เป็น http://<ip เครื่องนี้>:5000)
    // /patients ยังต้องมี token + origin ที่อนุญาต · ครั้งแรก Windows Firewall จะถามให้อนุญาต
    // ponytail: http ธรรมดา token วิ่งในแลนแบบไม่เข้ารหัส — ถ้าต้องกันดักในแลนค่อยทำ https
    srv.listen(get().port || PORT, '0.0.0.0', () => {
      server = srv
      resolve()
    })
  })
}

/** url ที่เครื่องอื่นใช้เรียกเครื่องนี้ได้ — localhost ก่อน ตามด้วย IPv4 ทุกการ์ดแลน */
export function urls(port: number): string[] {
  const ips = Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n!.address)
  return ['localhost', ...ips].map((h) => `http://${h}:${port || PORT}`)
}

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve()
    server.closeAllConnections()
    server.close(() => resolve())
    server = null
  })
}
