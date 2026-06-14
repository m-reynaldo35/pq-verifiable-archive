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
- [x] `hashPdf(pdfBuffer: Buffer): string` — returns `sha256:<hex>`
- [x] Never write PDF to disk; operate on buffer only
- [x] Unit test: same PDF → same hash; 1-byte change → different hash

### 1.2 — Merkle Batcher (`src/merkleBatcher.ts`)
- [x] Accumulate `{ envelopeId, leafHash, signingMetadata }` entries
- [x] On flush: build Merkle tree with `merkletreejs`
- [x] Return: `{ merkleRoot, leaves: [{ envelopeId, leafHash, merkleProof, signingMetadata }], batchId }`

### 1.3 — Algorand Anchor (`src/algorandAnchor.ts`)
- [x] Build note payload:
      `{ protocol:"pqva/1", merkleRoot, batchId, count, signers:[{passkeyPublicKey, passkeySignature}] }`
- [x] Assert note ≤ 1024 bytes; hash signingMetadata if over limit
- [x] Submit 0-ALGO payment txn to testnet via algosdk
- [x] Return `{ txnId, confirmedRound }`

### 1.4 — ML-DSA Bundle Signer (`src/bundleSigner.ts`)
- [x] Load DocuSign ML-DSA private key from env
- [x] `signBundle(bundle): string` — returns ML-DSA signature over canonical bundle bytes
- [x] `verifyBundle(bundle, signature, publicKey): boolean`

**Acceptance:** `scripts/test-anchor.ts` with 3 sample PDFs → one testnet txn whose
note contains the Merkle root and signer metadata, visible at testnet.explorer.perawallet.app.

---

## Phase 2 — State Proof Collector
**Goal:** Retrieve the state proof round that covers the anchor transaction and store
all data needed for the auditor.

### 2.1 — State Proof Fetcher (`src/stateProofCollector.ts`)
- [x] Accept `{ txnId, confirmedRound }`
- [x] Calculate state proof round: `Math.ceil(confirmedRound / 256) * 256`
- [x] Poll `GET /v2/stateproofs/{stateProofRound}` until available (retry 2 min, timeout 25 min)
- [x] Return `{ stateProofRound, blockTimestamp }`

### 2.2 — Proof Bundle Assembler (`src/proofBundleAssembler.ts`)
- [x] Combine all fields into proof bundle schema (see above)
- [x] Sign bundle with DocuSign ML-DSA key
- [x] Write to `bundles/bundle-{envelopeId}.json`

**Acceptance:** A saved bundle for each test envelope containing all fields needed
for the auditor — no field requires a DocuSign server to interpret.

---

## Phase 3 — Offline Verifier CLI
**This is the demo.**

### `verifier/verify.ts` — CLI using `commander`

```
Usage: npx tsx verifier/verify.ts --bundle <path> [--pdf <path>]
```

- [x] Step 1 — Hash match: `SHA-256(pdfBytes) === bundle.pdfHash`
- [x] Step 2 — Merkle inclusion: walk `bundle.merkleProof` from leaf to `bundle.merkleRoot`
- [x] Step 3 — AlgoNode txn lookup: confirm note contains `bundle.merkleRoot` and signer metadata
- [x] Step 4 — State proof confirmation: confirm `bundle.stateProofRound` exists on AlgoNode
- [x] Step 5 — ML-DSA verify: `mlDsa65.verify(bundle.docusignMLDSASignature, bundleBytes, docusignPublicKey)`

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
- [x] `POST /webhook/docusign`
- [x] Validate `X-DocuSign-Signature-1` HMAC-SHA256 (reject + 400 if invalid)
- [x] On `status === "completed"`: fetch combined PDF from DocuSign API
- [x] Extract signer passkey metadata from envelope data
- [x] Pass to Merkle Batcher queue
- [x] Respond 200 immediately

### 4.2 — DocuSign API Client (`src/docusignClient.ts`)
- [x] OAuth 2.0 token exchange (sandbox)
- [x] `downloadEnvelopePdf(envelopeId): Promise<Buffer>`
- [x] `getSignerMetadata(envelopeId): Promise<SignerMetadata[]>`

**Acceptance:** `npm run e2e` sends envelope → webhook fires → bundle generated → verifier VALID.

---

## Phase 5 — Pitch Materials

- [x] `docs/pitch.md` — 1-pager: the problem, the solution, build vs. borrow
- [x] `docs/compliance-faq.md` — pre-empt legal/compliance questions
- [x] `docs/architecture.md` — data flow, proof bundle schema
- [x] `assets/sample-contract.pdf` — generic sample for demo
- [x] README comparison table

---

## Phase 6 — Demo UI (Optional)

Single-page app: upload PDF + bundle → verify client-side → step-by-step results → VALID/INVALID banner.

---

## Phase 7 — MCP Server (AI Agent Interface)
**Goal:** Expose anchor and verify as MCP tools so any Claude agent (or MCP-compatible model) can call them directly, with x402 micropayment handled automatically.

**Why:** AI agents that draft, route, or process signed documents need a simple primitive — "anchor this hash, give me a proof bundle." MCP is the standard interface. This is the product for the agent economy.

### 7.1 — Install MCP SDK
- [x] `npm install @modelcontextprotocol/sdk`
- [x] Add `"mcp": "tsx src/mcp-server.ts"` to `package.json` scripts

### 7.2 — MCP Server (`src/mcp-server.ts`)
- [x] Stdio transport (works with Claude Desktop, Claude Code, any MCP host)
- [x] Tool: `anchor_document`
  - Input: `hash` (SHA-256 hex string) + optional `metadata` (envelope ID, signers array)
  - Action: builds single-leaf Merkle tree → anchors to Algorand → assembles and signs bundle
  - Output: full proof bundle JSON + `algorandTxnId`
- [x] Tool: `verify_bundle`
  - Input: `bundle` (proof bundle JSON object) + optional `pdf_base64`
  - Action: runs all 5 verification checks
  - Output: `{ valid, steps[], signers[] }`
- [ ] Tool: `get_bundle` (optional)
  - Input: `algorandTxnId`
  - Action: fetches bundle from archive store by txn ID
  - Output: proof bundle JSON

### 7.3 — README: Claude Desktop / Claude Code install block
- [x] Add `mcp` config snippet to README so users can add it in 3 lines

**Acceptance:** Claude can call `anchor_document` and receive a valid proof bundle. `verify_bundle` returns correct pass/fail on the sample bundle.

---

## Phase 8 — x402 Payment Gate
**Goal:** Charge per anchor via x402 micropayment to treasury. Keep gas fees covered by a centralized signer wallet. Make the service self-sustaining at near-zero cost.

**Model:**
- Price: $0.01 USDC per `anchor_document` call (hosted service)
- Gas (Algorand txn fee): ~0.001 ALGO (~$0.0002) — covered by signer wallet, offset by the $0.01 charge
- `verify_bundle` is free (read-only, no on-chain cost)
- Self-hosted: free — runs against your own Algorand wallet, no payment gate

### 8.1 — x402 Middleware on Anchor Endpoint
- [x] Add `POST /api/anchor` REST endpoint to `src/server.ts`
  - Accepts `{ hash, envelope_id?, signers? }` JSON body
  - Returns proof bundle JSON
- [x] Add x402 paywall middleware to `/api/anchor` using `@x402-avm/express` + `@x402-avm/avm`
  - Facilitator: GoPlausible hosted (`X402_FACILITATOR_URL`, self-hostable)
  - Treasury: `X402_TREASURY_ADDRESS` (Algorand address, receives USDC)
  - Toll: `X402_TOLL_USD` (default `$0.01`)
  - Gate disabled gracefully when `X402_TREASURY_ADDRESS` unset (open for self-hosters)
- [x] Paywall in `src/anchorPaywall.ts` — isolated, easy to swap or remove

### 8.2 — MCP Server routes through REST endpoint
- [ ] `anchor_document` MCP tool calls `POST /api/anchor` internally (so payment gate applies)
- [ ] Pass-through: agent's x402 payment header forwarded to the REST call

### 8.3 — Signer wallet top-up monitoring
- [ ] Document minimum ALGO balance needed in signer wallet (e.g. 1 ALGO covers ~1000 anchors)
- [ ] Add startup warning if signer wallet balance below threshold

**Acceptance:** Calling `anchor_document` without a valid x402 payment returns 402. With payment, anchor completes and USDC lands in treasury.

---

## Phase 9 — Open Source Cleanup
**Goal:** Publish a clean, well-documented open source repo that anyone can self-host or integrate against the hosted service.

### 9.1 — License
- [x] Replace `"license": "ISC"` in `package.json` with `"license": "MIT"`
- [x] Add `LICENSE` file (MIT, copyright Mark Reynolds 2026)

### 9.2 — Repository hygiene
- [x] Verify `.gitignore` covers `.env`, `bundles/`, `assets/*.pdf`, `node_modules/`
- [x] Audit source for hardcoded values — only pinned public txn ID in verifyBundle.ts (intentional)
- [x] Review `archive/` — demo data only, `.example` email addresses, no real PII

### 9.3 — README update
- [x] Updated goal: open-source PQ tamper-evidence layer for any signed document
- [x] MCP quick-start block (Claude Desktop config)
- [x] x402 pricing section ($0.01/anchor hosted, free to self-host)
- [x] Self-host instructions
- [x] "Who uses this" section: HR, legal, healthcare, AI agents

### 9.4 — `.env.example` update
- [x] Added `X402_TREASURY_ADDRESS`, `X402_TOLL_USD`, `X402_FACILITATOR_URL`

**Acceptance:** A developer with no prior context can clone, fill in `.env`, run `npm start` and `npm run mcp`, and anchor a document in under 10 minutes.

---

## Phase 10 — Launch
**Goal:** Get the project in front of the Algorand ecosystem, MCP community, and legal/HR tech buyers.

### 10.1 — Blog post (`docs/blog-post.md`)
- [ ] Title: "Post-quantum document anchoring for AI agents on Algorand"
- [ ] ~600 words: the problem (RSA/ECDSA won't survive quantum), the solution (ML-DSA + Algorand Falcon-512), why agents need this (autonomous agreements need tamper-proof receipts), how to add it to Claude in 3 lines, pricing
- [ ] Publish on Mirror, dev.to, or personal site

### 10.2 — MCP registry submission
- [ ] Submit to MCP server directory / awesome-mcp list
- [ ] Package as standalone npm publish: `pqva-mcp` (or scoped under existing org)

### 10.3 — Algorand ecosystem
- [ ] Post in Algorand Discord (#builders channel)
- [ ] Submit to Algorand Foundation showcase / developer grants page
- [ ] Reference LabTrace as prior art, differentiate: documents vs. lab data, PQ-first

### 10.4 — Community
- [ ] Product Hunt launch (hook: "Post-quantum DocuSign alternative for AI agents")
- [ ] Post in r/algorand, r/MachineLearning (AI agent angle)
- [ ] Reach out to HR/legal tech newsletters: Legaltech News, HR Brew

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
