// node --test src/main/agent.test.mjs — Node ≥ 22.18 รัน .ts ได้เอง (strip types)
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { addDays, checkAlerts, demoPatients, demoScope, maskCid, scopePatients, today } from './agent.ts'

const d = today()

test('demo /patients: 3 ราย วันนี้ ค้นด้วยสกุลร่วม', () => {
  const rows = demoPatients(d, d, 'ทดสอบ')
  assert.deepEqual(rows.map((r) => r.diag_code).sort(), ['A90', 'A91', 'A925'])
  for (const r of rows) {
    assert.equal(r.date_dx, d)
    assert.match(r.area_code, /^65\d{6}$/)
    assert.match(r.cid, /^\d{13}$/)
    assert.match(r.symptom, /^CC : .+\nPI : .+$/)
  }
  const dhf = rows.find((r) => r.diag_code === 'A91')
  assert.equal(dhf.patient_type, 'IPD')
  assert.ok(dhf.an)
  assert.deepEqual(dhf.diags.map((x) => x.code), ['A91', 'E86'])
  assert.equal(dhf.disease_code, '26')
  // ผลล่าสุดของแต่ละรายการ — platelet บ่ายทับเช้า และมี , จึงครอบ "
  assert.match(dhf.lab_result, /Platelet count,"38,000"$/m)
  assert.doesNotMatch(dhf.lab_result, /45,000/)
})

test('demo /patients: กรองชื่อทุกคำ และช่วงวันที่', () => {
  assert.equal(demoPatients(d, d, 'มาลี ทดสอบ').length, 1)
  assert.equal(demoPatients(d, d, 'มาลี ไม่มี').length, 0)
  assert.equal(demoPatients(d, d, '  ').length, 0)
  assert.equal(demoPatients('2000-01-01', '2000-01-02', 'ทดสอบ').length, 0)
})

test('demo /patients/scope: ตามรหัส', () => {
  assert.deepEqual(demoScope(d, ['A925']).map((r) => r.diag_code), ['A925'])
  assert.equal(demoScope('2000-01-01', ['A925']).length, 0)
  assert.ok(demoScope(d, ['A91'])[0].lab_result)
  assert.equal(demoScope(d, ['A91'], { labs: false })[0].lab_result, undefined)
})

// HOSxP ปลอม — แทน mysql.createConnection เก็บ sql/params ทุกคิวรี · คิวรีหลักคืน 1 visit, lab คืนว่าง
const fakeDb = () => {
  const qs = []
  const row = { vn: '690101080000', hn: '1', icd10: 'A90', src: 2, diagtype: '1', dx_date: '2026-01-01', dx_time: '08:00:00', fname: 'ก' }
  mock.method(mysql, 'createConnection', async () => ({
    query: async (sql, params) => { qs.push({ sql, params }); return [qs.length === 1 ? [row] : []] },
    end: async () => {}
  }))
  return qs
}
const conn = { engine: 'mysql', host: 'x', port: 3306, user: 'u', password: 'p', database: 'd' }

test('scope HOSxP: รหัสกรองด้วย exists ผูก vn ของวันนั้น · ? ตรงจำนวน params · ดึง lab', async (t) => {
  t.after(() => mock.restoreAll())
  const qs = fakeDb()
  const rows = await scopePatients(conn, '2026-01-01', ['A90', 'A91', "x'; drop"])
  assert.equal(rows.length, 1)
  assert.equal(qs.length, 2)                                     // คิวรีหลัก + lab
  const [{ sql, params }] = qs
  assert.doesNotMatch(sql, /in \(select vn from ovstdiag/)        // ไม่ดึง vn ทุกปีของรหัส
  assert.equal((sql.match(/exists \(select 1 from ovstdiag q where q\.vn = (t|v)\.vn/g) ?? []).length, 2)
  assert.equal((sql.match(/\?/g) ?? []).length, params.length)
  const c = ['A90', 'A91']                                       // รหัสที่ไม่ผ่าน ICD_RE ไม่เข้า SQL
  assert.deepEqual(params, ['2026-01-01', '2026-01-01', ...c, ...c, '2026-01-01', '2026-01-01', ...c, ...c])
  assert.match(qs[1].sql, /from lab_head/)
})

test('อาชีพ: demo มีรหัส/ชื่อ HOSxP · คิวรีจริง join occupation · ตัดช่องว่าง ไม่มีอาชีพ = ไม่ส่ง', async (t) => {
  t.after(() => mock.restoreAll())
  const occ = Object.fromEntries(demoPatients(d, d, 'ทดสอบ').map((r) => [r.fname, [r.occupation, r.occupation_name, r.occupation_code]]))
  assert.deepEqual(occ, { ก้องภพ: ['900', 'นักเรียน/นักศึกษา/แม่บ้าน/พ่อบ้าน', '06'], มาลี: ['403', 'รับจ้าง', '03'], วันดี: ['502', 'เกษตรกรรม', '01'] })
  const rows = [{ vn: '1', hn: '1', occupation: ' 403 ', occupation_name: 'รับจ้าง ', occupation_code: '03' }, { vn: '2', hn: '2', occupation: '', occupation_name: null }]
  const qs = []
  mock.method(mysql, 'createConnection', async () => ({ query: async (sql) => { qs.push(sql); return [qs.length === 1 ? rows : []] }, end: async () => {} }))
  const [a, b] = (await scopePatients(conn, '2026-01-01', ['A90'])).sort((x, y) => x.vn.localeCompare(y.vn))
  assert.match(qs[0], /left join occupation oc on oc\.occupation = p\.occupation/)
  assert.deepEqual([a.occupation, a.occupation_name, a.occupation_code], ['403', 'รับจ้าง', '03'])
  assert.deepEqual([b.occupation, b.occupation_name, b.occupation_code], [undefined, undefined, undefined])
})

test('แจ้งเตือน HOSxP: ไม่ยิงคิวรี lab', async (t) => {
  t.after(() => mock.restoreAll())
  const qs = fakeDb()
  const f = fake()
  await checkAlerts({ ...base, demo: false, conn }, {}, f.post, log, '2026-01-01')
  assert.equal(qs.length, 1)
  assert.doesNotMatch(qs[0].sql, /lab_head/)
  assert.equal(f.calls.length, 1)
})

// ไม่ยิง MOPH Alert จริง — post เป็นตัวปลอมเก็บ payload ไว้ตรวจ
const A = '1659900000011'
const B = '3659900000022'
const base = {
  demo: true,
  icd10: [{ code: 'A90', name: '' }, { code: 'A91', name: '' }],
  alerts: [{ cid: A, name: 'ก', enabled: true }, { cid: B, name: 'ข', enabled: false }]
}
const fake = () => {
  const calls = []
  return { calls, post: async (b) => { calls.push(b) } }
}
const logs = []
const log = (m) => logs.push(m)

test('แจ้งเตือน: ตรงรหัส → 1 ข้อความต่อคนไข้ ต่อผู้รับที่เปิดเตือน ครั้งเดียว', async () => {
  const sent = {}
  const f = fake()
  const r = await checkAlerts(base, sent, f.post, log)
  assert.ok(r.ok)
  assert.equal(f.calls.length, 2)                      // A90 + A91 (Zika ไม่อยู่ในรหัส) · B ปิดเตือน
  assert.ok(f.calls.every((c) => c.cid.length === 1 && c.cid[0] === A))
  const day = new Date(`${d}T00:00:00`).toLocaleDateString('th-TH', { dateStyle: 'medium' })
  const text = f.calls.map((c) => c.message_text)
  assert.ok(text.includes(
    `พบการวินิจฉัยโรคตามรหัสที่ท่านตั้งไว้\nวัน-เวลา : ${day}-09:30\nมีการบันทึกการวินิจฉัย A90 - Dengue fever [classical dengue] ใน HOSXP\nนางมาลี ทดสอบ`))
  assert.ok(text.includes(
    `พบการวินิจฉัยโรคตามรหัสที่ท่านตั้งไว้\nวัน-เวลา : ${day}-08:15\nมีการบันทึกการวินิจฉัย A91 - Dengue haemorrhagic fever ใน HOSXP\nด.ช.ก้องภพ ทดสอบ`))
  assert.equal(f.calls[0].messages[0].type, 'flex')
  assert.equal(Object.keys(sent).length, 2)
  // รอบถัดไป (หรือเปิดโปรแกรมใหม่ด้วย sent เดิม) ไม่ส่งซ้ำ
  await checkAlerts(base, sent, f.post, log)
  assert.equal(f.calls.length, 2)
  // เปิดเตือน B ทีหลัง → ส่งเฉพาะ B (2 ราย)
  await checkAlerts({ ...base, alerts: base.alerts.map((a) => ({ ...a, enabled: true })) }, sent, f.post, log)
  assert.equal(f.calls.length, 4)
  assert.ok(f.calls.slice(2).every((c) => c.cid[0] === B))
  // เพิ่มรหัส A925 → ส่งเฉพาะคนไข้ใหม่ 1 ราย ให้ผู้รับที่เปิดเตือนทั้ง 2 คน
  await checkAlerts({ ...base, icd10: [...base.icd10, { code: 'A925', name: '' }], alerts: base.alerts.map((a) => ({ ...a, enabled: true })) }, sent, f.post, log)
  assert.equal(f.calls.length, 6)
  assert.match(f.calls[4].message_text, /A925 - Zika virus disease ใน HOSXP\nนางสาววันดี ทดสอบ$/)
  assert.ok(logs.every((m) => !m.includes(A) && !m.includes(B)))   // log ไม่มีเลขบัตรเต็ม
  assert.ok(logs.some((m) => m.includes(maskCid(A))))
})

test('แจ้งเตือน: ส่งไม่สำเร็จ = ไม่ลงคีย์ รอบหน้าส่งใหม่', async () => {
  const sent = {}
  const r = await checkAlerts(base, sent, async () => { throw new Error('HTTP 500') }, log)
  assert.equal(r.ok, false)
  assert.deepEqual(sent, {})
  const f = fake()
  await checkAlerts(base, sent, f.post, log)
  assert.equal(f.calls.length, 2)
})

test('แจ้งเตือน: ไม่มีผู้รับ = ข้าม · วันอื่นไม่มีคนไข้ · ตัดคีย์เก่า', async () => {
  const f = fake()
  assert.equal((await checkAlerts({ ...base, alerts: [] }, {}, f.post, log)).skip, true)
  const old = { [`${addDays(d, -10)}|x|${A}`]: addDays(d, -10), [`${addDays(d, -1)}|y|${A}`]: addDays(d, -1) }
  await checkAlerts(base, old, f.post, log, '2000-01-01')   // วันที่ไม่ใช่วันนี้ → demo ไม่มีคนไข้
  assert.equal(f.calls.length, 0)
  const sent = { [`${addDays(d, -10)}|x|${A}`]: addDays(d, -10), [`${addDays(d, -1)}|y|${A}`]: addDays(d, -1) }
  await checkAlerts(base, sent, f.post, log)
  assert.ok(!(`${addDays(d, -10)}|x|${A}` in sent))
  assert.ok(`${addDays(d, -1)}|y|${A}` in sent)
})
