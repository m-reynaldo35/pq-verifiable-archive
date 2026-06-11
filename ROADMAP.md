# PQ Verifiable Archive — Project Roadmap

**Goal:** Build a working proof-of-concept that demonstrates a post-quantum, vendor-independent
tamper-evidence layer for DocuSign envelopes — suitable for internal pitch to DocuSign
product/security leadership.

**The pitch in one sentence:** DocuSign anchors Merkle roots of envelope hashes to Algorand
(hashes only — no documents, no PII on-chain), embeds signer passkey metadata in the anchor
transaction so Algorand's native Falcon state proofs quantum-resistantly cover who signed and
when, and ships an offline verifier so any party can prove envelope integrity decades from now
without trusting DocuSign's servers or any live infrastructure.

**Why now:** DocuSign is in early PQC research with nothing shipped. NIST finalised ML-DSA
(FIPS-204) in 2024. CNSA 2.0 mandates PQC migration in federal/regulated procurement by
~2030–2035. The window to propose this is open.

---

## What This Is NOT

- Not a replacement for DocuSign's signing UX or identity layer
- Not a USDC escrow or payment product
- Not "blockchain for e-signatures" — only hashes and signing metadata touch the chain
- Not claiming e-signatures themselves become quantum-proof — only the long-term archive anchor

---

## Architecture Overview

```
DocuSign Connect Webhook
        │
        ▼
  Webhook Handler          ← validates HMAC-SHA256, downloads completed PDF
        │
        ▼
  Document Hasher          ← SHA-256(PDF bytes), never stores document
        │
        ▼
  Merkle Batcher           ← collects N hashes per interval, builds Merkle tree
        │
        ▼
  Algorand Anchor          ← posts merkleRoot + signer passkey metadata in txn note
        │
        ▼
  Algorand Network         ← Falcon state proofs cover the transaction automatically
        │
        ▼
  Proof Bundle Assembler   ← JSON per envelope: hash + merkle proof + txn + ML-DSA sig
        │
        ▼
  Offline Verifier CLI     ← given PDF + bundle: outputs VALID/INVALID
                              steps 1-2 fully offline
                              steps 3-4 via AlgoNode public API (not DocuSign)
                              step 5 fully offline
```

**Proof bundle schema (v1):**
```json
{
  "protocol": "pqva/1",
  "envelopeId": "...",
  "pdfHash": "sha256:...",
  "batchId": "...",
  "merkleRoot": "...",
  "merkleProof": ["sibling_hash_0", "sibling_hash_1"],
  "algorandTxnId": "...",
  "algorandRound": 12345678,
  "blockTimestamp": "2026-06-11T09:00:00Z",
  "stateProofRound": 12345952,
  "signingMetadata": {
    "signers": [
      { "passkeyPublicKey": "...", "passkeySignature": "..." }
    ]
  },
  "docusignKeyRegistrationTxnId": "...",
  "docusignMLDSASignature": "..."
}
```

**DocuSign institutional key:** ML-DSA (FIPS-204) — fully standardised, NIST approved.
Registered once in an Algorand transaction. Signs every proof bundle.

**Signer identity:** Passkey public key + signature embedded in Algorand anchor note.
Algorand's Falcon state proofs cover the note content — quantum-resistant record of who
signed and when. When FIDO PQC ships, passkeys upgrade to ML-DSA automatically.
No architectural changes required.

---

## Verification Steps

| Step | What | Offline? |
|------|------|----------|
| 1 | SHA-256(PDF) matches bundle.pdfHash | Yes |
| 2 | merkleProof walks from pdfHash to merkleRoot | Yes |
| 3 | AlgoNode confirms txn note contains merkleRoot | AlgoNode only — not DocuSign |
| 4 | AlgoNode confirms signer metadata in that txn | AlgoNode only — not DocuSign |
| 5 | ML-DSA signature over bundle verifies against registered DocuSign key | Yes |

---

## Phase 0 — Project Setup
**Status:** Complete

- [x] Create project directory
- [x] Initialise git
- [x] Scaffold: `src/`, `scripts/`, `verifier/`, `bundles/`, `docs/`, `assets/`
- [x] `npm init`, install dependencies:
      `algosdk`, `@noble/post-quantum`, `typescript`, `dotenv`,
      `express`, `merkletreejs`, `commander`, `tsx`, `@types/node`, `qrcode`
- [x] `tsconfig.json`
- [x] `.env` with all required vars (not committed — see `.env.example`)
- [x] `.env.example` and `.gitignore`
- [x] Anchor wallet generated — funded with 10 ALGO on mainnet
      Address: `SM26BRE7UJ42QN2IXUHO3BXQE5YUYVDOJHB5VXQ3GJPQXR5NYC2DZEOEIE`
- [x] ML-DSA-65 key registered on Algorand mainnet
      Txn: `GXXOVCP25WUQ5SI55SF6ZRDKIEHWJE2KOEUOCDRIO7VG3KOKJUMA`
      PK Hash: `sha256:b5b54bb3fe3e9c00b42df2caefa4b550bfc29f09b1c7e88ec3853c42d2756288`
      Network: **mainnet** (user sent 10 real ALGO — switched from testnet)

---

## Phase 1 — Document Hasher + Anchor Service
**Goal:** Given a PDF, hash it and anchor the Merkle root + signer metadata on Algorand testnet.

### 1.1 — Document Hasher (`src/documentHasher.ts`)
- [ ] `hashPdf(pdfBuffer: Buffer): string` — returns `sha256:<hex>`
- [ ] Never write PDF to disk; operate on buffer only
- [ ] Unit test: same PDF → same hash; 1-byte change → different hash

### 1.2 — Merkle Batcher (`src/merkleBatcher.ts`)
- [ ] Accumulate `{ envelopeId, leafHash, signingMetadata }` entries
- [ ] On flush: build Merkle tree with `merkletreejs`
- [ ] Return: `{ merkleRoot, leaves: [{ envelopeId, leafHash, merkleProof, signingMetadata }], batchId }`

### 1.3 — Algorand Anchor (`src/algorandAnchor.ts`)
- [ ] Build note payload:
      `{ protocol:"pqva/1", merkleRoot, batchId, count, signers:[{passkeyPublicKey, passkeySignature}] }`
- [ ] Assert note ≤ 1024 bytes; hash signingMetadata if over limit
- [ ] Submit 0-ALGO payment txn to testnet via algosdk
- [ ] Return `{ txnId, confirmedRound }`

### 1.4 — ML-DSA Bundle Signer (`src/bundleSigner.ts`)
- [ ] Load DocuSign ML-DSA private key from env
- [ ] `signBundle(bundle): string` — returns ML-DSA signature over canonical bundle bytes
- [ ] `verifyBundle(bundle, signature, publicKey): boolean`

**Acceptance:** `scripts/test-anchor.ts` with 3 sample PDFs → one testnet txn whose
note contains the Merkle root and signer metadata, visible at testnet.explorer.perawallet.app.

---

## Phase 2 — State Proof Collector
**Goal:** Retrieve the state proof round that covers the anchor transaction and store
all data needed for the auditor.

### 2.1 — State Proof Fetcher (`src/stateProofCollector.ts`)
- [ ] Accept `{ txnId, confirmedRound }`
- [ ] Calculate state proof round: `Math.ceil(confirmedRound / 256) * 256`
- [ ] Poll `GET /v2/stateproofs/{stateProofRound}` until available (retry 2 min, timeout 25 min)
- [ ] Return `{ stateProofRound, blockTimestamp }`

### 2.2 — Proof Bundle Assembler (`src/proofBundleAssembler.ts`)
- [ ] Combine all fields into proof bundle schema (see above)
- [ ] Sign bundle with DocuSign ML-DSA key
- [ ] Write to `bundles/bundle-{envelopeId}.json`

**Acceptance:** A saved bundle for each test envelope containing all fields needed
for the auditor — no field requires a DocuSign server to interpret.

---

## Phase 3 — Offline Verifier CLI
**This is the demo.**

### `verifier/verify.ts` — CLI using `commander`

```
Usage: verify <pdf-path> <bundle-path>
```

- [ ] Step 1 — Hash match: `SHA-256(pdfBytes) === bundle.pdfHash`
- [ ] Step 2 — Merkle inclusion: walk `bundle.merkleProof` from leaf to `bundle.merkleRoot`
- [ ] Step 3 — AlgoNode txn lookup: confirm note contains `bundle.merkleRoot` and signer metadata
- [ ] Step 4 — State proof confirmation: confirm `bundle.stateProofRound` exists on AlgoNode
- [ ] Step 5 — ML-DSA verify: `mlDsa65.verify(bundle.docusignMLDSASignature, bundleBytes, docusignPublicKey)`

**Output on success:**
```
✓ PDF hash matches archive record
✓ Hash included in Merkle batch (root: abc123...)
✓ Merkle root anchored in Algorand txn ABCD... (2026-06-11T09:00:00Z)
✓ Signer passkey metadata confirmed in anchor transaction
✓ Transaction covered by Algorand state proof (round 12,345,952)
✓ DocuSign ML-DSA attestation valid — NIST FIPS-204

VALID — document integrity proven as of 2026-06-11T09:00:00Z
        AlgoNode confirms on-chain record.
        DocuSign attestation verified offline.
        Signer identity quantum-resistantly recorded via Algorand state proof.
```

**Acceptance:** Verifier passes on valid bundle. Fails correctly if:
(a) PDF modified, (b) bundle tampered, (c) wrong PDF, (d) ML-DSA signature invalid.

---

## Phase 4 — DocuSign Connect Bridge
**Goal:** Real webhook so the flow triggers automatically on envelope completion.

### 4.1 — Webhook Handler (`src/webhookHandler.ts`)
- [ ] `POST /webhook/docusign`
- [ ] Validate `X-DocuSign-Signature-1` HMAC-SHA256 (reject + 400 if invalid)
- [ ] On `status === "completed"`: fetch combined PDF from DocuSign API
- [ ] Extract signer passkey metadata from envelope data
- [ ] Pass to Merkle Batcher queue
- [ ] Respond 200 immediately

### 4.2 — DocuSign API Client (`src/docusignClient.ts`)
- [ ] OAuth 2.0 token exchange (sandbox)
- [ ] `downloadEnvelopePdf(envelopeId): Promise<Buffer>`
- [ ] `getSignerMetadata(envelopeId): Promise<SignerMetadata[]>`

**Acceptance:** `npm run e2e` sends envelope → webhook fires → bundle generated → verifier VALID.

---

## Phase 5 — Pitch Materials

- [ ] `docs/pitch.md` — 1-pager: the problem, the solution, build vs. borrow
- [ ] `docs/compliance-faq.md` — pre-empt legal/compliance questions
- [ ] `docs/architecture.md` — data flow, proof bundle schema
- [ ] `assets/sample-contract.pdf` — generic sample for demo
- [ ] README comparison table

---

## Phase 6 — Demo UI (Optional)

Single-page app: upload PDF + bundle → verify client-side → step-by-step results → VALID/INVALID banner.

---

## Key Reference

| Item | Value |
|---|---|
| Testnet Algod | `https://testnet-api.algonode.cloud` |
| Testnet Indexer | `https://testnet-idx.algonode.cloud` |
| Testnet Explorer | `https://testnet.explorer.perawallet.app` |
| ALGO Faucet | `https://bank.testnet.algorand.network` |
| State Proof interval | 256 rounds (~17 min) |
| State Proof signature | Falcon-512 (covers all txns in the block) |
| Algorand note field limit | 1024 bytes |
| DocuSign institutional key | ML-DSA / NIST FIPS-204 |
| NIST ML-DSA finalised | 2024 |
| CNSA 2.0 PQC deadline | ~2030–2035 |

---

## Architecture Decisions

- **Hashes only on-chain.** SHA-256 hashes are not reversible. No document content, no PII.
- **Signer metadata in anchor note.** Algorand's Falcon state proofs quantum-resistantly cover
  who signed and when. No separate ML-DSA signing ceremony required today.
- **ML-DSA for DocuSign's institutional key.** FIPS-204 is fully standardised — a defensible
  compliance claim. Falcon Round 3 is not standardised and may be incompatible with FN-DSA.
- **AlgoNode for txn verification.** Not DocuSign servers. Public, decentralised, free.
- **No offline Falcon state proof verifier.** Not in any JS library. Not needed for the PoC.
  Deferred — buildable later without changing the proof bundle schema.
- **Proof bundle is the artifact.** Self-contained JSON. DocuSign could store it alongside
  the envelope, email it to signers, or offer it as a download.
- **FIDO PQC upgrade path.** When ML-DSA passkeys ship in devices (2027–2028), signer
  identity becomes doubly quantum-resistant. No architectural changes required.
- **Merkle batching.** One txn per batch rather than one per envelope. Scales to thousands
  of envelopes per day at negligible cost (~$0.001/batch).
- **Protocol versioning.** `"protocol":"pqva/1"` in every note — future indexers can filter by version.
