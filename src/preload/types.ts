export type Engine = 'mysql' | 'postgres'

export type Conn = {
  engine: Engine
  host: string
  port: number
  user: string
  password: string
  database: string
}

/** รหัสโรคจาก icd101 ของ HIS (แบบไม่มีจุด เหมือน HOSxP) */
export type Icd = { code: string; name: string }

// ค่าเริ่มต้นของรหัสที่ดึง = กลุ่มไข้เลือดออก/ชิคุนกุนยา/ซิกา ที่ dc เปิดรายงาน (c_disease506 must_report)
export const DEFAULT_ICD: Icd[] = [
  { code: 'A90', name: 'Dengue fever [classical dengue]' },
  { code: 'A91', name: 'Dengue haemorrhagic fever' },
  { code: 'A910', name: 'Dengue hemorrhagic fever with shock' },
  { code: 'A911', name: 'Dengue hemorrhagic fever without shock' },
  { code: 'A919', name: 'Dengue hemorrhagic fever, unspecified' },
  { code: 'A920', name: 'Chikungunya virus disease' },
  { code: 'A925', name: 'Zika virus disease' }
]

export type Settings = {
  conn: Conn
  from: string // yyyy-mm-dd ช่วง vstdate ของ /patients — เปิดโปรแกรมใหม่ = ย้อนหลัง 30 วันถึงวันนี้เสมอ
  to: string
  origins: string // เว็บที่อนุญาตให้อ่านข้อมูล คั่นด้วย ,
  token: string // ผู้เรียก /patients ต้องส่ง Authorization: Bearer <token>
  icd10: Icd[] // รหัสโรคที่ดึง
}

export type Result = { ok: boolean; message: string }
