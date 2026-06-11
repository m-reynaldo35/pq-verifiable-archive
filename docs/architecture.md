# Architecture — PQ Verifiable Archive

For engineers evaluating feasibility. This describes the implemented system, not a
proposal: the components below exist in `src/` and `verifier/` and run against
Algorand mainnet.

---

## Data Flow

```
        DocuSign Connect Webhook  (envelope status = "completed")
                  │  X-DocuSign-Signature-1 (HMAC-SHA256), 200 returned immediately
                  ▼
        ┌───────────────────────┐
        │  Webhook Handler       │  src/webhookHandler.ts
        │  validate HMAC,        │  fetch completed PDF via DocuSign API,
        │  respond 200, async    │  extract signer metadata (name/email/signedAt)
        └───────────┬───────────┘
                    ▼
        ┌───────────────────────┐
        │  Document Hasher       │  src/documentHasher.ts
        │  SHA-256(pdfBytes)     │  buffer only — PDF is never written to disk
        └───────────┬───────────┘
                    ▼
        ┌───────────────────────┐
        │  Merkle Batcher        │  src/merkleBatcher.ts
        │  collect N leaf hashes │  build Merkle tree, derive per-leaf proof
        └───────────┬───────────┘
                    ▼
        ┌───────────────────────┐
        │  Algorand Anchor       │  src/algorandAnchor.ts
        │  note = {protocol,     │  0-ALGO txn; note <= 1024 bytes
        │  merkleRoot, batchId}  │  returns { txnId, confirmedRound }
        └───────────┬───────────┘
                    ▼
        ┌───────────────────────┐
        │  Algorand Network      │  Falcon-512 state proofs cover the block
        │  (mainnet)             │  automatically, ~every 256 rounds
        └───────────┬───────────┘
                    ▼
        ┌───────────────────────┐
        │  State Proof Collector │  src/stateProofCollector.ts
        │  round -> stateProof   │  stateProofRound = ceil(round/256)*256
        └───────────┬───────────┘
                    ▼
        ┌───────────────────────┐
        │  Bundle Assembler      │  src/proofBundleAssembler.ts
        │  + ML-DSA-65 sign      │  src/bundleSigner.ts (FIPS-204)
        └───────────┬───────────┘
                    ▼
        bundles/bundle-<envelopeId>.json   (self-contained artifact)
                    │
                    ▼
        ┌───────────────────────┐
        │  Offline Verifier CLI  │  verifier/verify.ts
        │  VALID (0) / INVALID(1)│  5 checks; only on-chain reads hit AlgoNode
        └───────────────────────┘
```

---

## Proof Bundle Schema (`pqva/1`)

The bundle is the durable artifact. It is JSON, canonicalised with JCS (RFC 8785)
before signing so the ML-DSA signature is stable across re-serialisation.

| Field | Type | Description |
|---|---|---|
| `protocol` | string | Always `"pqva/1"`. Lets future indexers filter by version. |
| `envelopeId` | string | DocuSign envelope identifier. |
| `documentHash` | string (hex) | SHA-256 of the completed PDF bytes. The Merkle leaf. |
| `batchId` | string | Identifier of the batch this leaf belongs to (defaults to the anchor txn ID). |
| `merkleRoot` | string (hex) | Root of the batch's Merkle tree; the value anchored on-chain. |
| `merkleProof` | string[] | Ordered sibling hashes from `documentHash` up to `merkleRoot`. |
| `algorandTxnId` | string | Transaction that carries `merkleRoot` in its note. |
| `algorandRound` | number | Confirmed round of the anchor transaction. |
| `blockTimestamp` | string (ISO 8601) | Wall-clock time the anchor was confirmed. |
| `stateProofRound` | number | Round whose Falcon-512 state proof covers the anchor block. |
| `signingMetadata.signers[]` | object[] | Optional passkey metadata: `passkeyPublicKey`, `passkeySignature`. |
| `docusignSigners[]` | object[] | Signer identity: `name`, `email`, `signedAt`. Covered by the signature. |
| `docusignKeyRegistrationTxnId` | string | On-chain txn that registered DocuSign's ML-DSA public key. |
| `algorithm` | string | Always `"ml-dsa-65"`. |
| `signature` | string (hex) | ML-DSA-65 signature over the JCS-canonical bundle minus `signature`. |

The signature covers every field except `signature` itself, so tampering with the
document hash, signer identity, or anchor reference invalidates verification.

---

## Verification (the five checks)

`verify.ts` exits `0` on VALID, `1` on INVALID, `2` on operational error. Order
front-loads the offline, cheap checks:

| # | Check | Method | Network |
|---|---|---|---|
| 1 | ML-DSA-65 attestation | `ml_dsa65.verify(signature, JCS(bundle\\signature), registeredPublicKey)` | Offline |
| 2 | PDF hash match (if `--pdf` given) | `SHA-256(pdfBytes) === documentHash` | Offline |
| 3 | Merkle inclusion | walk `merkleProof` from `documentHash` to `merkleRoot` | Offline |
| 4 | On-chain anchor | AlgoNode `lookupTransactionByID` → note contains `merkleRoot` | AlgoNode (not DocuSign) |
| 5 | State proof coverage | resolve state proof for `algorandRound` (reported, non-fatal in PoC) | AlgoNode (not DocuSign) |

Only checks 4 and 5 touch the network, and only the public AlgoNode API — never a
DocuSign server. Checks 1–3 work fully offline, so a bundle remains verifiable even
if every party's servers are gone.

---

## Key Reference

| Choice | Value | Why |
|---|---|---|
| Document hash | SHA-256 | Quantum-resistant for integrity (Grover only halves the search space); irreversible, so no PII on-chain. |
| Institutional signature | ML-DSA-65 (FIPS-204) | Finalised NIST standard, CNSA 2.0-approved, security category 3. Defensible to auditors. |
| Anchor chain | Algorand mainnet | Native Falcon-512 state proofs (PQC at consensus), public, permissionless, ~$0.001/batch. |
| Signer identity (today) | Passkey pubkey + signature in anchor note | Falcon state proofs cover the note; upgrades to ML-DSA passkeys with no schema change. |
| Canonicalisation | JCS (RFC 8785) | Deterministic JSON so the signature is stable across serialisers. |
| Batching | One txn per N envelopes | Amortises cost; scales to thousands/day at negligible fee. |

---

## State Proofs — what Falcon-512 covers, and when

Algorand validators collectively produce a **Falcon-512 state proof** roughly every
256 rounds (~17 minutes). Each state proof is a post-quantum attestation over the
ledger state spanning those rounds — it cryptographically commits to every
transaction in that window, including our anchor transaction and the signer metadata
it carries.

The collector computes the covering round as `ceil(confirmedRound / 256) * 256` and
records it in the bundle as `stateProofRound`. Once that state proof is generated,
the anchor — and therefore the Merkle root and signer metadata — is covered by a
post-quantum proof produced by the network itself, independent of DocuSign.

Note: there is no off-chain Falcon-512 state-proof *verifier* in any JS library
today, so the PoC reports state-proof coverage rather than re-verifying the proof
cryptographically offline. This is a deferred enhancement that requires no change to
the bundle schema — the `stateProofRound` reference is already captured.
