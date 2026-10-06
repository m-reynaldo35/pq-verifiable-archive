# Architecture — PQ Verifiable Archive

For engineers evaluating feasibility. This describes the implemented system: the
components below are in `src/` and `verifier/` and run against Algorand mainnet.

---

## Entry points

All four entry points call `createProofBundle()` in `src/proofBundleAssembler.ts`:

| Entry point | Auth / metering | Signer source |
|---|---|---|
| `POST /api/anchor` (hash only) | x402 payment, rate limit, payment replay guard | `requester-asserted` |
| `POST /api/archive` (PDF upload, operator UI) | `PORTAL_API_KEY`, rate limit | `requester-asserted` |
| `POST /webhook/docusign` (Connect 2.0) | HMAC-SHA256 over raw body, any `X-DocuSign-Signature-N`; idempotent per envelope | `docusign-connect` |
| MCP `anchor_document` | local stdio; daily cap `MCP_MAX_ANCHORS_PER_DAY` | `requester-asserted` |

## Data flow

```
 document hash (from client, or SHA-256 of uploaded / DocuSign-downloaded PDF)
        │
        ▼
 Merkle tree (src/merkleBatcher.ts)      leaf = H(0x00‖hash), node = H(0x01‖L‖R)
        │                                one document per tree today
        ▼
 Algorand anchor (src/algorandAnchor.ts) 0-ALGO self-payment from the issuer address
        │                                note = {"protocol":"pqva/2","op":"anchor",
        │                                        "merkleRoot", "envelopeCount",
        │                                        "envelopeIdsSha256"}
        ▼
 Bundle signer (src/bundleSigner.ts)     ML-DSA-65 over JCS(bundle without signature)
        │
        ▼
 bundle returned to caller; archive and webhook paths also store the bundle and PDF
 in Vercel Blob, or PQVA_ARCHIVE_DIR locally (src/archiveStore.ts, src/storage.ts)
```

Every call anchors one document in its own transaction. The Merkle structure is kept
so batching can be added later without a format change; there is no batching today.

The uploaded or downloaded PDF **is stored** (private Vercel Blob store in
production, a local directory otherwise) by the archive and webhook paths. `/api/anchor` and the MCP tool only ever see the hash.

---

## Proof bundle schema (`pqva/2`)

Canonicalised with JCS (RFC 8785) before signing. The signature covers every field
except `signature`.

| Field | Type | Description |
|---|---|---|
| `protocol` | string | `"pqva/2"` |
| `envelopeId` | string | Document / envelope identifier |
| `documentHash` | hex | SHA-256 of the document |
| `batchId` | string | Anchor txn ID |
| `merkleRoot` | hex | Root anchored on-chain |
| `merkleProof` | `{side, hash}[]` | Sibling hashes, with the side each sibling is on |
| `algorandTxnId` | string | Anchor transaction |
| `algorandRound` | number | Confirmed round of the anchor transaction |
| `blockTimestamp` | ISO 8601 | Ledger round time of the anchor (omitted if unavailable) |
| `stateProofRound` | number | First state-proof interval boundary ≥ `algorandRound` (hint only) |
| `issuerAddress` | string | Algorand address that sent the anchor |
| `keyRegistrationTxnId` | string | Issuer's `key-register` txn for this key |
| `signers[]` | object[] | `name`, `email`, `signedAt` |
| `signerSource` | string | `docusign-connect` or `requester-asserted` |
| `algorithm` | string | `"ml-dsa-65"` |
| `mldsaPublicKey` | hex | Issuer public key (1952 bytes) |
| `signature` | hex | ML-DSA-65 signature |

Legacy `pqva/1` bundles (sorted-pair Merkle tree without prefixes, `docusignSigners`,
`docusignKeyRegistrationTxnId`) are still accepted by the verifiers. Their signers are
always shown as requester-asserted.

---

## Verification

`verifier/verify.ts` exits `0` = valid, `1` = invalid, `2` = could not verify. The
verifier trusts an **issuer** configured on the command line (`--issuer-address`,
`--key-reg-txn`, optional `--pk-sha256`); by default it trusts the hosted service's
issuer and prints that it is doing so. It does not read `.env`.

| # | Check | Network |
|---|---|---|
| 1 | ML-DSA-65 signature over the bundle, and the key belongs to the trusted issuer: its fingerprint equals the pinned one, or a `key-register` txn **sent by the issuer address** records it. Any lookup failure is an error, never a pass. For `pqva/2`, `issuerAddress` must equal the trusted issuer. | None if the fingerprint is pinned; otherwise indexer |
| 2 | `SHA-256(document) === documentHash` (skipped without `--pdf`; the result then says "document not checked") | None |
| 3 | Merkle proof from `documentHash` to `merkleRoot` | None |
| 4 | Anchor txn: sender is the trusted issuer, confirmed round equals `algorandRound`, note parses as JSON with matching `protocol`, `op: "anchor"` and exactly `merkleRoot` (and the envelope digest for single-document anchors). `blockTimestamp` must be within 60 s of the ledger round time, which is reported as the anchoring time. | Indexer |
| 5 | Informational: does the indexer list a state-proof txn whose attested range covers the round? | Indexer |

**Trust in the indexer.** Checks 4 and 5 trust the indexer's responses. A malicious
indexer could invent an anchor transaction from the issuer address. Pointing the
verifier at an indexer you control, or cross-checking two, reduces that risk; the
complete fix is to verify a light-block-header proof against a Falcon-512 state proof,
which this project does not do yet.

The browser verifier (`public/index.html`, "Verify Independently") implements the same
checks against the public AlgoNode indexer, pinned to the hosted issuer. The page
itself is served by the hosted server, so it is not independent of that server.

---

## Key reference

| Choice | Value | Why |
|---|---|---|
| Document hash | SHA-256 | Collision and preimage resistance hold up against Grover-type quantum attacks at this size |
| Issuer signature | ML-DSA-65 (FIPS-204) | NIST standard, CNSA 2.0-approved, category 3 |
| Merkle tree | RFC 6962-style prefixes, ordered pairs | Leaf/node domain separation |
| Anchor chain | Algorand mainnet | Public, permissionless, low fee; produces Falcon-512 state proofs |
| Canonicalisation | JCS (RFC 8785) | Deterministic JSON for the signature |
| Issuer pinning | Address + key fingerprint, configured by the verifier | A bundle cannot name its own trust anchor |

---

## Deployment (Vercel)

- `api/index.ts` exports the Express app as a single Vercel function;
  `vercel.json` rewrites every non-static path to it and serves `public/` from
  the CDN with the security headers. `src/server.ts` is the long-running entry
  point for local development (`npm run dev`).
- Connect a **private** Vercel Blob store. It holds archive records, bundles and
  PDFs, plus one-time claims for x402 payment headers and DocuSign envelopes, so
  replay protection and webhook idempotency hold across function instances.
- `NODE_ENV` is `production` on Vercel. If `PORTAL_API_KEY`,
  `X402_TREASURY_ADDRESS`, the ML-DSA keys or the Blob store are missing, every
  request returns 503 and the reason is logged.
- Webhook processing continues after the 200 response via `waitUntil`
  (function `maxDuration` 60 s).
- Rate limits are in-memory per function instance, so they are best-effort on
  Vercel. Add a Vercel Firewall rate-limit rule for `/api/anchor` and
  `/api/verify` for a global limit.
- The x402 middleware settles payment after the handler runs. The durable replay
  guard stops a payment header being used twice, but a payment that ultimately
  fails to settle still produces one anchor. Settling before anchoring would
  close this completely.
