// รันคิวรีของ /patients กับฐานจริง: node --no-warnings scripts/check.ts <engine> <host> <port> <user> <password> <db> <from> <to>
import assert from 'node:assert'
import { patients } from '../src/main/agent.ts'
import { DEFAULT_ICD } from '../src/preload/types.ts'

const [engine = 'mysql', host = '127.0.0.1', port = '3306', user = 'root', password = '', database = 'hos', from = '2024-04-20', to = '2024-04-30'] =
  process.argv.slice(2)
const rows = await patients({ engine: engine as 'mysql', host, port: Number(port), user, password, database }, from, to, DEFAULT_ICD.map((i) => i.code))
for (const r of rows) {
  assert.ok(r.disease_code, `ไม่มีรหัสโรคของ ${r.diag_code}`)
  assert.match(String(r.date_visit), /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(r.date_visit! >= from && r.date_visit! <= to, `วันที่หลุดช่วง ${r.date_visit}`)
}
assert.equal(new Set(rows.map((r) => r.vn)).size, rows.length, 'vn ซ้ำ')
assert.equal(new Set(rows.map((r) => `${r.hn} ${r.date_visit}`)).size, rows.length, 'คนเดียววันเดียวเกิน 1 แถว')
console.log(rows.length, 'rows ok')
console.log(rows.slice(0, 3))
