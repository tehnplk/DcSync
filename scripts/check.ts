// รันคิวรีของ /patients กับฐานจริง: node --no-warnings scripts/check.ts <engine> <host> <port> <user> <password> <db> <from> <to> [name]
import assert from 'node:assert'
import { MAX_ROWS, patients, pickRows } from '../src/main/agent.ts'

// diags: ทุกรหัสของ visit เฉพาะขึ้นต้น A–Y (ไม่เอา Z / ตัวเลข) · เรียง diagtype ก่อน IPD/OPD · รหัสซ้ำ OPD/IPD เหลือตัวเดียว (ไม่ต้องต่อฐาน)
const [v] = pickRows([
  { vn: '1', src: 2, diagtype: '2', icd10: 'J069', diag_name: 'URI' },
  { vn: '1', src: 2, diagtype: '1', icd10: 'A910', diag_name: 'DHF' },
  { vn: '1', src: 2, diagtype: '4', icd10: 'Z768', diag_name: 'Z' },
  { vn: '1', src: 1, diagtype: '1', icd10: 'A910', diag_name: 'DHF' },
  { vn: '1', src: 1, diagtype: '2', icd10: 'K746', diag_name: 'Cirrhosis' },
  { vn: '1', src: 2, diagtype: '1', icd10: 'R509', diag_name: 'Fever' },
  { vn: '1', src: 2, diagtype: '1', icd10: '9904', diag_name: 'หัตถการ' },
])
assert.deepEqual((v.diags as { code: string }[]).map((d) => d.code), ['A910', 'R509', 'K746', 'J069'])

const [engine = 'mysql', host = '127.0.0.1', port = '3306', user = 'root', password = '', database = 'hos', from = '2024-04-20', to = '2024-04-30', name = 'สม'] =
  process.argv.slice(2)
const conn = { engine: engine as 'mysql', host, port: Number(port), user, password, database }
const rows = await patients(conn, from, to, name)
for (const r of rows) {
  for (const w of name.split(/\s+/).filter(Boolean)) assert.ok(`${r.fname} ${r.lname}`.includes(w), `ชื่อไม่ตรง ${w}: ${r.fname} ${r.lname}`)
  assert.match(String(r.date_visit), /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(r.date_visit! >= from && r.date_visit! <= to, `วันที่หลุดช่วง ${r.date_visit}`)
}
assert.equal(new Set(rows.map((r) => r.vn)).size, rows.length, 'vn ซ้ำ')
assert.ok(rows.length <= MAX_ROWS, `เกิน ${MAX_ROWS} แถว`)
assert.deepEqual(await patients(conn, from, to, '  '), [], 'ไม่มีชื่อต้องไม่คืนใคร')
console.log(rows.length, 'rows ok')
console.log(rows.slice(0, 3))
