# Prompt: Membangun Paraf, Library Workflow Approval dari Nol

> **Paraf** adalah library workflow approval untuk JavaScript/TypeScript, dipublikasikan di npm dengan scope `@paraf`. Prompt ini dirancang untuk AI coding agent (Claude Code atau sejenisnya) dan dikerjakan **per fase**.

---

## Peran

Kamu adalah senior software engineer yang berpengalaman membangun library open-source TypeScript berkualitas produksi. Kamu peduli pada API yang bersih, type safety, test yang menyeluruh, dan dokumentasi yang jelas. Kamu menulis kode yang mudah dipahami kontributor lain.

## Tujuan

Bangun **Paraf**, library workflow approval yang dinamis dan dipublikasikan ke npm. Paraf terdiri dari:

1. **Engine headless** yang menjalankan flow approval berdasarkan definisi JSON.
2. **Adapter storage** untuk PostgreSQL dan MySQL.
3. **Editor visual** (mirip draw.io) untuk menyusun flow lewat UI drag-and-drop.

Engine tidak boleh bergantung pada database, framework UI, atau struktur user/role tertentu. Semua yang spesifik aplikasi disuntikkan lewat adapter dan resolver.

---

## Struktur Repository

Monorepo dengan **pnpm workspaces**:

```
packages/
  core/          → @paraf/core       (engine, types, validator, evaluator, MemoryStore)
  postgres/      → @paraf/postgres   (adapter, driver: pg)
  mysql/         → @paraf/mysql      (adapter, driver: mysql2)
  store-tests/   → test suite bersama untuk semua adapter (private, tidak dipublish)
  editor/        → @paraf/editor     (React + @xyflow/react)
examples/
  basic-node/    → contoh pemakaian engine dengan MemoryStore
  express-postgres/
  editor-demo/   → Vite app untuk mencoba editor
```

## Tech Stack

- TypeScript `strict: true`, target ES2020
- Build: `tsup`, output ESM + CJS + `.d.ts`, dengan field `exports` yang benar
- Test: Vitest; adapter dites terhadap database sungguhan lewat `docker-compose` (Postgres 16, MySQL 8)
- Lint/format: ESLint + Prettier
- Versioning & changelog: **Changesets**, mengikuti SemVer
- CI: GitHub Actions (lint, typecheck, test semua package, termasuk test adapter dengan service container)
- `@paraf/core` harus **zero runtime dependency**

---

## Konsep Inti

### 1. Flow Definition (JSON)

Flow adalah data JSON yang bisa disimpan, divalidasi, dan diedit lewat UI. Rancang dan ekspor **JSON Schema** sekaligus type TypeScript-nya.

```json
{
  "id": "purchase-request",
  "version": 1,
  "name": "Pengajuan Pembelian",
  "start": "supervisor",
  "resubmitPolicy": "restart",
  "nodes": {
    "supervisor": {
      "type": "approval",
      "label": "Atasan Langsung",
      "approvers": [{ "type": "supervisor", "level": 1 }],
      "mode": "any",
      "excludeRequester": true,
      "onEmptyApprovers": "skip",
      "timeout": { "after": "P3D", "action": "escalate", "to": [{ "type": "supervisor", "level": 2 }] },
      "next": "checkAmount",
      "onReject": "end_rejected"
    },
    "checkAmount": {
      "type": "condition",
      "rules": [{ "when": { ">": [{ "var": "amount" }, 10000000] }, "next": "chain" }],
      "else": "review"
    },
    "chain": {
      "type": "approval-chain",
      "label": "Naik sampai Direktur",
      "chain": "supervisor",
      "from": "requester",
      "until": { "type": "role", "value": "director" },
      "includeStopper": true,
      "maxLevels": 5,
      "duplicateApprover": "auto-approve",
      "next": "review",
      "onReject": "end_rejected"
    },
    "review": {
      "type": "approval",
      "label": "Manager & Finance (paralel)",
      "groups": [
        { "id": "mgr", "label": "Manager", "approvers": [{ "type": "role", "value": "manager" }], "mode": "any" },
        {
          "id": "fin", "label": "Finance",
          "approvers": [{ "type": "role", "value": ["finance", "accounting"] }],
          "mode": { "minimum": 2 },
          "rejectPolicy": "impossible",
          "onInsufficientApprovers": "cap"
        }
      ],
      "require": "all",
      "duplicateApprover": "require",
      "next": "end_approved",
      "onReject": "end_rejected"
    },
    "end_approved": { "type": "end", "result": "approved" },
    "end_rejected": { "type": "end", "result": "rejected" }
  },
  "layout": { "supervisor": { "x": 100, "y": 80 } }
}
```

Tipe node: `approval`, `approval-chain`, `condition`, `end`. Field `layout` hanya dipakai editor dan diabaikan engine.

### 2. Approver Resolver (dinamis)

Engine tidak mengenal role, group, atau atasan. Aplikasi mendaftarkan resolver untuk setiap tipe approver:

```ts
engine.registerApproverType('role', async (config, ctx) => {
  // config.value bisa string atau string[] (lebih dari satu role)
  return userIds; // string[]
}, {
  label: 'Berdasarkan Role',
  configSchema: { value: { type: 'multiselect', label: 'Role', options: async () => [...] } }
});
```

- Tipe bawaan: `user` (daftar ID langsung) dan `field` (ambil ID dari data dokumen).
- `ctx` berisi `requester`, `subject`, `document` (data pengajuan), `instance`.
- Satu daftar `approvers` boleh berisi banyak entri (misalnya beberapa role berbeda). Hasilnya digabung jadi satu daftar dan **dideduplikasi**.
- `excludeRequester` membuang pengaju dari daftar approver.
- **Approver di-snapshot** saat instance masuk ke step, lalu disimpan per user dan per kelompok, dengan status `pending | approved | rejected | delegated | skipped`.
- `onEmptyApprovers` (hasil resolve kosong): `"error" | "skip" | "fallback"`.
- Metadata (`label`, `configSchema`) dipakai editor untuk menampilkan form konfigurasi secara otomatis.

**Re-resolve.** Sediakan `engine.reresolveApprovers(instanceId, actorId)` untuk admin, dipakai misalnya saat anggota role berubah atau ada approver yang keluar perusahaan:
- Keputusan yang **sudah diberikan tetap dihitung**, walaupun orang tersebut tidak lagi ada di hasil resolve baru.
- Approver lama yang belum merespons dan tidak ada lagi di hasil baru dihapus; approver baru ditambahkan sebagai `pending`.
- Setelah re-resolve, status step dievaluasi ulang (bisa langsung selesai jika syarat sudah terpenuhi).
- Dicatat di audit trail.

### 3. Mode Persetujuan

Berlaku per kelompok approver (lihat bagian 4).

| Mode | Arti |
|---|---|
| `"any"` | Cukup 1 approver setuju |
| `"all"` | Semua approver hasil resolve harus setuju (contoh: semua user dengan role tertentu) |
| `{ "minimum": n }` | Minimal n approver setuju; n bilangan bulat ≥ 1 |

**Satu orang satu suara** di dalam satu kelompok, walaupun ia muncul dari beberapa sumber approver atau menerima delegasi dari orang lain yang juga approver di kelompok tersebut.

**Jumlah approver kurang dari minimum** (`onInsufficientApprovers`). Berlaku saat jumlah approver hasil resolve lebih kecil dari `minimum`:
- `"error"` (default): instance gagal masuk step dan melempar `InsufficientApproversError`; tercatat di audit.
- `"cap"`: minimum diturunkan menjadi jumlah approver yang tersedia; nilai efektif dicatat di `config` step dan di audit.
- `"fallback"`: tambahkan `fallbackApprovers` sampai jumlahnya cukup; jika tetap kurang, perlakukan seperti `"error"`.

**Kebijakan reject** (`rejectPolicy`):
- `"any"`: satu reject langsung membuat kelompok gagal. Default untuk mode `any` dan `all`.
- `"impossible"`: kelompok gagal hanya jika jumlah approve ditambah approver yang belum merespons sudah tidak mungkin mencapai minimum. Default untuk mode `minimum`.
- `{ "minimum": n }`: kelompok gagal setelah ada n reject.

Saat step selesai (approved atau rejected), approver yang belum merespons ditandai `skipped` dan tidak bisa bertindak lagi di step tersebut.

**Delegasi.** `delegate(instanceId, fromUserId, toUserId)` memindahkan hak suara dari A ke B di step aktif, di semua kelompok tempat A berada. Jika B sudah menjadi approver di kelompok yang sama, B tetap hanya punya satu suara dan slot A ditandai `delegated` (tidak dihitung). Perilaku ini memengaruhi perhitungan `all` dan `minimum`, sehingga harus dijelaskan di dokumentasi dan dites.

### 4. Kelompok Approver (paralel dalam satu node)

Untuk syarat seperti "minimal 1 manager **dan** minimal 2 orang finance", satu node `approval` bisa berisi beberapa kelompok, masing-masing dengan aturannya sendiri:

```json
"groups": [
  { "id": "mgr", "approvers": [{ "type": "role", "value": "manager" }], "mode": "any" },
  { "id": "fin", "approvers": [{ "type": "role", "value": "finance" }], "mode": { "minimum": 2 } }
],
"require": "all"
```

- Setiap kelompok memiliki: `id` (unik dalam node), `label`, `approvers`, `mode`, `rejectPolicy`, `excludeRequester`, `onEmptyApprovers`, `onInsufficientApprovers`, `fallbackApprovers`.
- `require` di tingkat node: `"all"` (semua kelompok terpenuhi), `"any"` (salah satu kelompok cukup), atau `{ "minimum": n }` (minimal n kelompok terpenuhi).
- Semua kelompok dinotifikasi bersamaan saat node dimasuki.
- Node dinyatakan **rejected** begitu `require` sudah tidak mungkin terpenuhi (misalnya `require: "all"` dan satu kelompok gagal).
- Kelompok dengan `onEmptyApprovers: "skip"` dianggap terpenuhi dan dicatat di audit.
- **User yang ada di beberapa kelompok** (misalnya punya role manager dan finance): opsi node `countAcrossGroups`, default `true`, artinya satu keputusan orang itu dihitung di semua kelompok tempat ia berada. Jika `false`, ia hanya dimasukkan ke kelompok pertama (sesuai urutan di `groups`) yang memuatnya.
- **Bentuk singkat:** node dengan `approvers` + `mode` (tanpa `groups`) diperlakukan sebagai satu kelompok dengan id `"default"` dan `require: "all"`. Node tidak boleh memiliki `approvers` dan `groups` sekaligus.

### 5. Approval Bertahap

Approval bertahap (misalnya supervisor lalu direktur) dibangun dengan merangkai node lewat `next`. Level berikutnya baru dinotifikasi setelah level sebelumnya selesai; reject di satu level menjalankan `onReject` tanpa melanjutkan ke level berikutnya. Kasus tepi yang wajib ditangani:

**a. Orang yang sama muncul di beberapa level** (`duplicateApprover`, per node):
- `"require"` (default): tetap harus menyetujui lagi.
- `"auto-approve"`: jika user sudah **menyetujui** step lain di instance yang sama (dalam putaran yang sama, yaitu sejak start atau resubmit terakhir), slot-nya otomatis `approved` dengan `actor_id` null dan aksi audit `auto_approved` yang merujuk ke keputusan sebelumnya.

**b. Pengaju berada di level atas.** Misalnya direktur mengajukan sendiri: setelah `excludeRequester`, level direktur kosong dan ditangani `onEmptyApprovers` (biasanya `"skip"`). Jadikan contoh eksplisit di dokumentasi dan test.

**c. Rantai atasan dengan kedalaman dinamis** (node `approval-chain`). Untuk aturan seperti "naik terus ke atasan sampai ketemu direktur", yang jumlah levelnya berbeda tiap departemen:

```ts
// aplikasi mendaftarkan cara mencari "langkah berikutnya" dalam rantai
engine.registerChain('supervisor', async (fromUserId, ctx) => {
  return supervisorIdOf(fromUserId); // string | null (null = puncak rantai)
});
```

- `chain`: nama chain yang terdaftar. `from`: `"requester"` (default) atau `{ "field": "pic_user_id" }`.
- Engine membuat **satu step per level** secara berurutan saat runtime: level 1 = `chain(from)`, level 2 = `chain(approver level 1)`, dan seterusnya.
- `until`: entri approver (misalnya `{ "type": "role", "value": "director" }`); rantai berhenti saat approver level saat ini termasuk hasil resolve `until`. `includeStopper` (default `true`) menentukan apakah orang itu tetap harus menyetujui.
- `maxLevels` wajib ada sebagai pengaman; jika tercapai sebelum `until` terpenuhi, step terakhir tetap diproses dan instance lanjut ke `next`. Catat di audit.
- Rantai berhenti juga jika resolver mengembalikan `null`. Jika rantai kosong sejak awal (pengaju tidak punya atasan), tangani dengan `onEmptyApprovers`.
- Deteksi siklus (A → B → A) dan hentikan dengan error.
- Reject di level mana pun menjalankan `onReject` node. `duplicateApprover` dan `excludeRequester` tetap berlaku per level.

**d. Revisi dan resubmit** (`resubmitPolicy`, di tingkat flow, bisa di-override per panggilan `returnForRevision`):
- `"restart"` (default): setelah resubmit, flow mulai lagi dari `start`, dan semua level harus menyetujui ulang.
- `"resume"`: setelah resubmit, flow lanjut dari node yang mengembalikan dokumen; level sebelumnya tidak perlu menyetujui ulang.
- Setiap kunjungan ulang ke node menghasilkan step baru dengan `iteration` bertambah, sehingga riwayat putaran sebelumnya tetap utuh.

### 6. Evaluasi Kondisi

**Dilarang** memakai `eval`, `new Function`, atau sejenisnya. Implementasikan evaluator kecil bergaya JSON Logic di dalam core: operator `==`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `and`, `or`, `not`, `var` (mendukung path seperti `"items.0.price"`). Operator custom bisa didaftarkan lewat `engine.registerOperator()`.

### 7. Subject: Relasi ke Dokumen Aplikasi

Setiap instance terhubung ke satu dokumen milik aplikasi melalui `subject`:

```ts
const instance = await engine.start('purchase-request', {
  subject: { type: 'purchase_request', id: '42' },
  requester: { id: 'u7' },
  document: { amount: 15000000, departmentId: 'IT' }
});
// aplikasi menyimpan instance.id di tabel dokumennya, misalnya purchase_requests.approval_instance_id
```

- `subject.type` dan `subject.id` berupa **string bebas**; library tidak memaksa format ID aplikasi (integer, UUID, atau kode seperti `PR/2026/10/007` semuanya valid).
- Relasi dua arah: aplikasi menyimpan `instance.id`, dan library bisa mencari dari arah sebaliknya lewat `findInstances({ subject })`.
- Hanya boleh ada satu instance aktif (`pending`, `in_progress`, `returned`) per subject; dijamin oleh constraint database, bukan hanya pengecekan di kode.
- Semua event membawa `instance.subject`, supaya aplikasi bisa memperbarui kolom ringkasan status di tabelnya sendiri:
  ```ts
  engine.on('instance.completed', async ({ instance }) => {
    await db.purchaseRequests.update(instance.subject.id, { status: instance.status });
  });
  ```
- Library adalah sumber kebenaran untuk detail approval; aplikasi hanya menyimpan ID instance dan ringkasan status.

### 8. Identifier (UUID v7)

- Semua ID yang dibuat library (instance, step, approver slot, audit entry) memakai **UUID v7** (RFC 9562), karena berurutan berdasarkan waktu dan ramah index database.
- Implementasikan generator UUID v7 sendiri di core (tanpa dependency), dengan test format dan urutannya (monoton untuk ID yang dibuat dalam milidetik yang sama).
- Sediakan opsi `createEngine({ generateId })` agar user bisa memakai generator ID sendiri.
- Di API publik, ID selalu berupa **string** berformat UUID standar.
- `flow.id`, `node.id`, dan `group.id` adalah slug yang ditentukan user (misalnya `purchase-request`), bukan UUID.

### 9. Instance, Step & State Machine

Status instance: `pending → in_progress → approved | rejected | cancelled`, ditambah `returned` (dikembalikan untuk revisi).

Setiap kali instance masuk ke node approval, engine membuat **step** (untuk `approval-chain`, satu step per level). Status step: `active | approved | rejected | skipped | returned | cancelled`. Node `condition` dan `end` tidak membuat step, tetapi tercatat di audit.

Aksi yang didukung:
- `start(flowId, { subject, requester, document })`
- `approve(instanceId, userId, comment?)`
- `reject(instanceId, userId, comment)`
- `returnForRevision(instanceId, userId, comment, { toNodeId?, resubmitPolicy? })`: default kembali ke pengaju
- `resubmit(instanceId, userId, newDocumentData?)`
- `delegate(instanceId, fromUserId, toUserId, reason?)`
- `cancel(instanceId, userId, reason?)`: hanya pengaju atau admin
- `reresolveApprovers(instanceId, actorId)`

Setiap aksi divalidasi: user harus berhak, dan instance harus berada di status yang sesuai. Gunakan error bertipe (`NotAuthorizedError`, `InvalidStateError`, `ConcurrencyError`, `FlowValidationError`, `InsufficientApproversError`, `ChainCycleError`, dan sebagainya), bukan string.

### 10. Versioning Flow

- Menyimpan flow selalu menghasilkan **versi baru** dan tidak pernah menimpa versi lama.
- Instance menyimpan `flowId` + `flowVersion` dan selamanya memakai versi tersebut.
- Instance baru memakai versi aktif. Sediakan `publishFlow` (simpan versi baru dan jadikan aktif), `activateFlowVersion` (rollback ke versi lama), dan `getActiveFlow`.

### 11. Concurrency

Gunakan **optimistic locking**: instance memiliki field `revision`, dan `updateInstance(instance, expectedRevision)` gagal jika revision sudah berubah. Engine melakukan retry otomatis secara terbatas, lalu melempar `ConcurrencyError`. Wajib ada test dua approver yang menekan approve bersamaan pada mode `all`, mode `minimum`, dan node dengan beberapa kelompok.

### 12. Timeout & Eskalasi

Engine **tidak boleh** menjalankan timer atau cron sendiri. Sediakan `engine.processTimeouts(now?: Date)` yang dipanggil aplikasi secara berkala (lewat cron, queue, atau scheduler masing-masing). Durasi memakai format ISO 8601 (`P3D`, `PT12H`). Batas waktu disimpan di `due_at` milik step.

### 13. Audit Trail

Setiap perubahan dicatat sebagai entri append-only: `id`, `instanceId`, `stepId`, `nodeId`, `action`, `actorId` (null jika oleh sistem), `comment`, `timestamp`, `metadata`. Aksi minimal: `started`, `step_entered`, `approved`, `auto_approved`, `rejected`, `delegated`, `returned`, `resubmitted`, `escalated`, `reresolved`, `skipped`, `condition_evaluated`, `cancelled`, `completed`. Sediakan `engine.getHistory(instanceId)`.

### 14. Events / Hooks

Engine memancarkan event bertipe: `instance.created`, `step.entered`, `approval.required` (berisi daftar approver per kelompok, berguna untuk notifikasi), `step.completed`, `instance.completed`, `instance.returned`, `timeout.escalated`, `approvers.reresolved`. Notifikasi (email, WA, dan lainnya) **bukan** tanggung jawab library; aplikasi menangani lewat event ini.

### 15. Validasi Flow

`validateFlow(flow, { approverTypes?, chains? })` mengembalikan daftar error yang terstruktur (dengan `nodeId`, `groupId` jika ada, `code`, dan pesan), bukan melempar error di error pertama. Cek minimal:
- `start` dan semua referensi `next`, `else`, `onReject` menunjuk ke node yang ada
- Ada minimal satu node `end`, dan semua node dapat dijangkau dari `start`
- Tidak ada node tanpa jalan keluar (selain `end`)
- Deteksi loop tak berujung (loop hanya boleh lewat `returnForRevision`)
- Node `condition` wajib memiliki `else`
- Node `approval` memiliki `approvers` **atau** `groups`, tidak keduanya; setiap kelompok memiliki minimal satu approver; `group.id` unik dalam node
- `require` `{ minimum: n }` harus bilangan bulat ≥ 1 dan ≤ jumlah kelompok
- Tipe approver dan chain sudah terdaftar (jika `approverTypes` / `chains` diberikan)
- `minimum` dan `rejectPolicy` `{ minimum: n }` harus bilangan bulat ≥ 1
- Jika semua approver di sebuah kelompok bertipe `user` (jumlahnya bisa diketahui secara statis), `minimum` tidak boleh melebihi jumlah user unik tersebut
- `onEmptyApprovers` / `onInsufficientApprovers` bernilai `"fallback"` wajib memiliki `fallbackApprovers`
- Node `approval-chain` wajib memiliki `chain` dan `maxLevels` (bilangan bulat ≥ 1)
- Ekspresi kondisi valid

Engine wajib memvalidasi saat `publishFlow`. Editor memakai fungsi yang sama untuk menampilkan error secara langsung.

---

## Storage Adapter

### Interface (di core)

```ts
interface ParafStore {
  // flow
  saveFlowVersion(flow: FlowDefinition): Promise<void>;
  setActiveVersion(flowId: string, version: number): Promise<void>;
  getFlowVersion(flowId: string, version: number): Promise<FlowDefinition | null>;
  getActiveFlow(flowId: string): Promise<FlowDefinition | null>;
  listFlows(): Promise<FlowSummary[]>;
  // instance (beserta step dan approver slot-nya)
  createInstance(state: InstanceState): Promise<void>;
  getInstance(id: string): Promise<InstanceState | null>;
  updateInstance(state: InstanceState, expectedRevision: number): Promise<boolean>;
  findInstances(query: InstanceQuery): Promise<Paginated<Instance>>; // by subject, status, flow
  findPendingForUser(userId: string, page?: PageQuery): Promise<Paginated<PendingItem>>; // inbox
  findTimedOut(now: Date): Promise<InstanceState[]>;
  // audit
  appendAudit(entries: AuditEntry[]): Promise<void>;
  getAudit(instanceId: string): Promise<AuditEntry[]>;
}
```

- `InstanceState` = instance + step-step-nya + slot approver tiap step.
- `createInstance` dan `updateInstance` menyimpan instance, step, approver, **dan entri audit dari aksi yang sama** secara atomik dalam satu transaksi.
- Sertakan `MemoryStore` di core untuk test dan contoh.

### Skema acuan (PostgreSQL)

Prefix tabel default `paraf_`, bisa dikonfigurasi.

```sql
-- Definisi flow, satu baris per versi (tidak pernah di-update)
CREATE TABLE paraf_flows (
  flow_id      VARCHAR(100) NOT NULL,
  version      INT          NOT NULL,
  name         VARCHAR(255) NOT NULL,
  definition   JSONB        NOT NULL,
  created_by   VARCHAR(255),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, version)
);

-- Penunjuk versi aktif per flow
CREATE TABLE paraf_flow_heads (
  flow_id         VARCHAR(100) PRIMARY KEY,
  active_version  INT          NOT NULL,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  FOREIGN KEY (flow_id, active_version) REFERENCES paraf_flows (flow_id, version)
);

-- Satu baris per dokumen yang sedang/sudah menjalani approval
CREATE TABLE paraf_instances (
  id               UUID         PRIMARY KEY,
  flow_id          VARCHAR(100) NOT NULL,
  flow_version     INT          NOT NULL,
  subject_type     VARCHAR(100) NOT NULL,
  subject_id       VARCHAR(255) NOT NULL,
  requester_id     VARCHAR(255) NOT NULL,
  status           VARCHAR(20)  NOT NULL,  -- pending | in_progress | returned | approved | rejected | cancelled
  current_step_id  UUID,                   -- null jika tidak ada step aktif
  round            INT          NOT NULL DEFAULT 1,  -- naik setiap resubmit; dipakai duplicateApprover
  document         JSONB        NOT NULL,
  revision         INT          NOT NULL DEFAULT 0,  -- optimistic locking
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  FOREIGN KEY (flow_id, flow_version) REFERENCES paraf_flows (flow_id, version)
);
CREATE INDEX idx_paraf_inst_subject ON paraf_instances (subject_type, subject_id);
CREATE INDEX idx_paraf_inst_status  ON paraf_instances (status);
CREATE UNIQUE INDEX uq_paraf_inst_active_subject
  ON paraf_instances (subject_type, subject_id)
  WHERE status IN ('pending', 'in_progress', 'returned');

-- Setiap kali instance masuk ke node approval (approval-chain: satu baris per level)
CREATE TABLE paraf_steps (
  id            UUID         PRIMARY KEY,
  instance_id   UUID         NOT NULL REFERENCES paraf_instances (id),
  node_id       VARCHAR(100) NOT NULL,
  iteration     INT          NOT NULL,           -- kunjungan ke-berapa ke node ini
  chain_level   INT          NOT NULL DEFAULT 0, -- 0 untuk node approval biasa
  round         INT          NOT NULL,
  status        VARCHAR(20)  NOT NULL,           -- active | approved | rejected | skipped | returned | cancelled
  config        JSONB        NOT NULL,           -- snapshot aturan efektif per kelompok (mode, minimum hasil cap, rejectPolicy, require)
  entered_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  due_at        TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  UNIQUE (instance_id, node_id, iteration, chain_level)
);
CREATE INDEX idx_paraf_steps_instance ON paraf_steps (instance_id);
CREATE INDEX idx_paraf_steps_due      ON paraf_steps (status, due_at);

-- Snapshot approver per step, satu baris per orang per kelompok
CREATE TABLE paraf_approvers (
  id              UUID         PRIMARY KEY,
  step_id         UUID         NOT NULL REFERENCES paraf_steps (id),
  instance_id     UUID         NOT NULL,   -- denormalisasi untuk query inbox
  group_id        VARCHAR(100) NOT NULL DEFAULT 'default',
  user_id         VARCHAR(255) NOT NULL,
  source          JSONB,                   -- asal approver, misalnya {"type":"role","value":"manager"}
  status          VARCHAR(20)  NOT NULL,   -- pending | approved | rejected | delegated | skipped
  delegated_from  VARCHAR(255),
  auto_from_step  UUID,                    -- diisi jika auto-approve karena duplicateApprover
  decided_at      TIMESTAMPTZ,
  comment         TEXT,
  UNIQUE (step_id, group_id, user_id)
);
CREATE INDEX idx_paraf_appr_user_pending ON paraf_approvers (user_id, status);
CREATE INDEX idx_paraf_appr_step         ON paraf_approvers (step_id);

-- Riwayat lengkap, hanya insert
CREATE TABLE paraf_audit (
  id           UUID         PRIMARY KEY,
  instance_id  UUID         NOT NULL REFERENCES paraf_instances (id),
  step_id      UUID,
  node_id      VARCHAR(100),
  action       VARCHAR(50)  NOT NULL,
  actor_id     VARCHAR(255),           -- null jika aksi oleh sistem
  comment      TEXT,
  metadata     JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_paraf_audit_instance ON paraf_audit (instance_id, created_at);
```

Query inbox ("menunggu approval user X") harus memakai index `(user_id, status)` dan join ke step berstatus `active`, tanpa membongkar kolom JSON:

```sql
SELECT i.*, s.node_id, s.due_at
FROM paraf_approvers a
JOIN paraf_steps s     ON s.id = a.step_id AND s.status = 'active'
JOIN paraf_instances i ON i.id = a.instance_id
WHERE a.user_id = $1 AND a.status = 'pending'
ORDER BY s.entered_at;
```

### Perbedaan untuk MySQL 8

| Hal | PostgreSQL | MySQL 8 |
|---|---|---|
| Kolom ID buatan library | `UUID` | `BINARY(16)`; adapter mengonversi string ↔ binary sehingga user tetap melihat string |
| JSON | `JSONB` | `JSON` |
| Waktu | `TIMESTAMPTZ` | `DATETIME(3)`, selalu disimpan dalam UTC |
| Partial unique index (satu instance aktif per subject) | `WHERE status IN (...)` | Tidak didukung. Pakai kolom `active_subject_key VARCHAR(360)` berisi `subject_type:subject_id` saat aktif dan `NULL` saat selesai, dengan `UNIQUE` (MySQL mengizinkan banyak `NULL`) |
| Engine tabel | – | Wajib InnoDB |

### Aturan adapter

- Postgres memakai `pg`, MySQL memakai `mysql2`. Driver dijadikan **peerDependency**, dan adapter menerima pool/connection dari user.
- Hindari fitur yang hanya ada di satu database (jangan bergantung pada `RETURNING`, upsert spesifik, dan sejenisnya, kecuali dibungkus dengan rapi).
- Jangan melakukan query ke dalam isi kolom JSON untuk kebutuhan inti.
- `updateInstance` melakukan `UPDATE ... WHERE id = ? AND revision = ?` dan mengecek jumlah baris terpengaruh, dalam transaksi yang sama dengan perubahan step, approver, dan audit.
- Sediakan `store.migrate()` dan juga file SQL mentah (`schema.postgres.sql`, `schema.mysql.sql`). Simpan versi skema di tabel `paraf_migrations` supaya migrasi berikutnya bisa dijalankan bertahap.
- Package `store-tests` berisi **satu test suite** yang dijalankan terhadap `MemoryStore`, Postgres, dan MySQL. Semua adapter wajib lolos test yang sama, termasuk round-trip UUID, constraint satu instance aktif per subject, dan rollback transaksi saat terjadi konflik revision.

---

## Editor Visual (`@paraf/editor`)

Komponen React berbasis `@xyflow/react`.

```tsx
<ParafEditor
  value={flow}
  onChange={setFlow}
  approverTypes={engine.getApproverTypes()}  // metadata untuk form konfigurasi
  chains={engine.getChains()}
  readOnly={false}
  onValidate={(errors) => ...}
/>
```

Fitur:
- Palet node (Approval, Approval Chain, Condition, End) yang bisa di-drag ke canvas
- Menyambungkan node dengan garis; edge dari condition diberi label rule/else; edge reject dibedakan secara visual
- Panel properti di samping:
  - Approval: label, satu kelompok (bentuk singkat) atau banyak kelompok yang bisa ditambah/dihapus, approver per kelompok (form dibangun otomatis dari `configSchema`, mendukung pilihan lebih dari satu role), mode (`any` / `all` / minimum), `rejectPolicy`, `onEmptyApprovers`, `onInsufficientApprovers`, fallback approver, `require` antar kelompok, `countAcrossGroups`, `duplicateApprover`, timeout
  - Approval Chain: chain, `from`, `until`, `includeStopper`, `maxLevels`, `duplicateApprover`
  - Condition: builder aturan sederhana, bukan input JSON mentah
  - Pengaturan flow: nama, `resubmitPolicy`
- Node approval menampilkan ringkasan di canvas (misalnya "Semua · role: director", "Min. 3 · group: komite", atau "Manager + Finance (min. 2)")
- Validasi langsung memakai `validateFlow` dari core; node yang error ditandai merah
- Undo/redo, zoom/pan, minimap, auto-layout sederhana
- Import/export JSON
- Komponen **controlled**: editor tidak menyimpan ke mana pun sendiri, semua lewat `value`/`onChange`
- Styling lewat CSS variables agar mudah diberi tema; tidak bergantung pada Tailwind atau UI library besar
- `react` dan `react-dom` sebagai peerDependency

---

## Fase Pengerjaan

Kerjakan **satu fase per waktu**. Di akhir setiap fase: jalankan lint, typecheck, dan test; ringkas apa yang dibuat; lalu **berhenti dan tunggu konfirmasi** sebelum lanjut.

**Fase 1: Fondasi**
Setup monorepo, tsconfig, tsup, Vitest, ESLint/Prettier, Changesets, CI. Types dan JSON Schema flow definition (termasuk `groups` dan `approval-chain`). Generator UUID v7. `validateFlow` beserta test lengkap.
*Selesai jika:* semua contoh flow valid lolos validasi, setiap aturan validasi punya test untuk kasus gagal, dan generator UUID v7 lolos test format serta urutan.

**Fase 2: Engine core**
Evaluator kondisi, registry approver resolver, subject, step, state machine, semua aksi, mode & rejectPolicy, onInsufficientApprovers, kelompok approver, delegasi, re-resolve, versioning flow, optimistic locking, audit, events, `MemoryStore`.
*Selesai jika:* skenario end-to-end berikut lolos, dengan coverage core ≥ 90%:
- multi-level bertahap (supervisor lalu direktur) dan percabangan kondisi
- `any`, `all` (semua user dengan role tertentu), dan `minimum: 3`
- approver dari lebih dari satu role dalam satu kelompok
- beberapa kelompok dengan `require` `all`, `any`, dan `{ minimum: n }`; user di dua kelompok dengan `countAcrossGroups` true dan false
- `minimum` dengan approver kurang dari n untuk ketiga opsi `onInsufficientApprovers`
- `rejectPolicy` `any`, `impossible`, dan `{ minimum: n }`
- satu orang satu suara (user dari dua sumber approver; delegasi ke user yang sudah approver)
- re-resolve yang mempertahankan keputusan lama
- reject, return & resubmit dengan `resubmitPolicy` `restart` dan `resume`, delegate, cancel
- approver kosong, excludeRequester, dan pengaju yang berada di level atas
- subject: `findInstances({ subject })` dan larangan dua instance aktif untuk subject yang sama
- concurrency pada `all`, `minimum`, dan node berkelompok

**Fase 3: Approval chain & duplicate approver**
Node `approval-chain` (registry chain, `until`, `includeStopper`, `maxLevels`, deteksi siklus) dan `duplicateApprover`.
*Selesai jika:* test rantai dengan kedalaman berbeda, rantai kosong, rantai mencapai `maxLevels`, siklus, reject di tengah rantai, dan auto-approve lintas level (termasuk tidak berlaku lintas putaran resubmit) lolos.

**Fase 4: Timeout & eskalasi**
`processTimeouts`, parsing durasi ISO 8601, aksi eskalasi.
*Selesai jika:* test dengan waktu yang dikontrol (fake timers / parameter `now`) lolos.

**Fase 5: Adapter database**
`store-tests`, adapter Postgres, adapter MySQL, migrasi, docker-compose.
*Selesai jika:* ketiga store (memory, postgres, mysql) lolos test suite yang sama di CI.

**Fase 6: Editor**
Komponen editor beserta demo Vite.
*Selesai jika:* flow contoh di bagian 1 bisa dibuat dari nol lewat UI, hasil export JSON lolos `validateFlow`, dan bisa di-import kembali tanpa kehilangan data.

**Fase 7: Dokumentasi & rilis**
README per package (quick start di bagian atas, konsep, API reference, contoh resolver role/group/supervisor, contoh chain, contoh relasi subject ke tabel aplikasi, penjelasan mode, kelompok, dan rejectPolicy dengan tabel contoh, serta diagram tabel database), folder `examples/`, CHANGELOG, LICENSE (MIT). Cek `npm pack --dry-run` untuk setiap package. Rilis awal `0.1.0`.

---

## Aturan Kerja

- Jangan menambahkan fitur di luar dokumen ini tanpa bertanya.
- Jika ada keputusan desain yang ambigu atau trade-off penting, jelaskan opsi beserta rekomendasimu, lalu tanya sebelum mengimplementasikan.
- Tulis test bersamaan dengan kode, bukan di akhir.
- API publik harus diekspor secara eksplisit dari `index.ts`; detail internal tidak boleh bocor.
- Setiap fungsi dan type publik diberi JSDoc singkat.
- Jangan pernah memakai `any` di API publik.
- Pesan error harus jelas dan menyebut konteks (`nodeId`, `groupId`, `instanceId`, aksi).

## Di Luar Cakupan (versi awal)

- Pengiriman notifikasi (cukup event)
- Autentikasi / manajemen user, role, dan group
- Scheduler internal
- REST/GraphQL API siap pakai
- Editor untuk framework selain React
