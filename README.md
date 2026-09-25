# DcSync

โปรแกรมบนเครื่องผู้ใช้ใน รพ. — ดึงเคสโรคที่ต้องรายงานจาก HIS (HOSxP บน MySQL/MariaDB หรือ PostgreSQL)
แล้วเปิด REST ที่ `http://localhost:5000` ให้เว็บ dc (แท็บ "ดึงจาก HOSXP") มาอ่าน
ทำแบบนี้เพราะ HIS อยู่ในวงแลนของโรงพยาบาล เซิร์ฟเวอร์เว็บเข้าไม่ถึง

## ติดตั้ง

ดาวน์โหลด `dcsync-<version>-setup.exe` จาก [Releases](https://github.com/tehnplk/DcSync/releases) แล้วติดตั้ง
เวอร์ชันถัดไปอัปเดตเอง: เปิดโปรแกรมแล้วดาวน์โหลดเบื้องหลัง ติดตั้งตอนปิดโปรแกรม

## ใช้งาน

1. แท็บ **เชื่อมต่อ HIS** — ใส่ข้อมูลฐาน HIS แล้วกด "ทดสอบการเชื่อมต่อ"
2. แท็บ **ข้อมูลที่ดึง** — ช่วงวันที่รับบริการ (ตั้งต้น ย้อนหลัง 30 วันถึงวันนี้) และรหัส ICD10 (ค้นจาก `icd101`)
3. กด **Start** · คัดลอก **Token** ไปวางในเว็บ dc

API (รับเฉพาะเครื่องนี้ 127.0.0.1 และเว็บที่อนุญาต):

- `GET /health`
- `GET /patients` — header `Authorization: Bearer <token>` · ใส่ `?from=yyyy-mm-dd&to=yyyy-mm-dd` ทับช่วงวันที่ได้

## พัฒนา

```bash
npm install
npm run dev          # ใน terminal ของ VS Code ต้อง unset ELECTRON_RUN_AS_NODE ก่อน
npm run typecheck
node --no-warnings scripts/check.ts mysql 127.0.0.1 3306 <user> <password> <db> 2024-01-01 2024-12-31
```

## ปล่อยเวอร์ชันใหม่

แก้ `version` ใน `package.json` แล้ว

```bash
GH_TOKEN=<github token> npm run release
```

electron-builder สร้างตัวติดตั้ง Windows และอัปโหลดขึ้น GitHub Releases (พร้อม `latest.yml` ที่ตัวอัปเดตใช้)
