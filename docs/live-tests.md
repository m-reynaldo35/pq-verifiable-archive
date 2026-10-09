# Live DocuSign tests

End-to-end runs of the hosted service against a real DocuSign developer (sandbox) account, anchoring on **Algorand mainnet**. Each run is recorded here with what was checked and how, so anyone can follow the flow and check the on-chain parts themselves.

The signed documents and bundles are not published: they carry the test signer's name and email. The Algorand transactions are public, and the [live example](#live-example) at `/try` is a document anyone can download and verify.

## The flow under test

```
 DocuSign (sandbox)                     PQ Verifiable Archive (Vercel)                Algorand mainnet
 ──────────────────                     ──────────────────────────────                ────────────────
 envelope completed
   └─ Connect: POST /webhook/docusign ─▶ 1. check HMAC (X-DocuSign-Signature-N)
      (JSON SIM, envelope-completed)     2. claim envelope (idempotent across instances)
                                         3. GET envelope status ── must be "completed"
                                         4. GET documents/combined?certificate=true
                                            GET recipients
                                         5. SHA-256(PDF) → Merkle root ───────────────▶ txn note:
                                                                                         {pqva/2, anchor,
                                                                                          merkleRoot,
                                                                                          envelopeIdsSha256}
                                         6. proof bundle signed with ML-DSA-65
                                            (signers = docusign-connect,
                                             capture = completion + archive time)
                                         7. archive PDF + bundle, issue signer link /d/<token>
   ◀── 200 (5xx on failure → Connect retries)
 signer opens /d/<token> ──────────────▶ download PDF + bundle, Verify now
 anyone, any time ─────────────────────▶ verify in the browser or CLI ◀──────────── indexer lookup
```

One log line per delivery in the function logs, e.g. `[webhook] event=envelope-completed envelope=… outcome=anchored`.

## Setup used

| | |
|---|---|
| DocuSign | developer sandbox (`demo.docusign.net`), JWT Grant (`signature impersonation`), Connect configuration: Custom, REST v2.1 JSON (SIM), event *Envelope Signed/Completed*, HMAC on |
| Service | https://pq-verifiable-archive.vercel.app, Vercel Functions + private Vercel Blob |
| Issuer | Algorand `XCJOXAMHVPXGFJHHKF3CUSVD7CD44Z4FB3BFXZYH46HYX6NUQ7TANSWAMM`, ML-DSA-65 key registered on-chain |

## Test 1: first live envelope (2026-10-09)

| Step | Result |
|---|---|
| Envelope | one-page agreement, one signer, signed from the DocuSign email |
| Completed (DocuSign) | 08:23:02 UTC |
| Connect delivery | 1 delivery, **0 failures** |
| Anchored | [`ZL4Y7DIETVI7LLKWGOQLUN4J2GXOFH5IRUV4REI65YKMKMMACXGQ`](https://explorer.perawallet.app/tx/ZL4Y7DIETVI7LLKWGOQLUN4J2GXOFH5IRUV4REI65YKMKMMACXGQ), round 65814693, about 26 s after completion |

**Finding: DocuSign regenerates the PDF on every download.** Downloading the completed envelope twice gave two different SHA-256 hashes. A byte comparison showed the differences are DocuSign's XMP `ModifyDate`/`MetadataDate`, the PDF trailer `/ID` and the `adbe.pkcs` signature seal, which is re-signed per download. A proof over "the envelope" can therefore never be matched against a later download.

**Decision:** the archived copy is the document of record. The archive captures the PDF once, seconds after completion; signers get those exact bytes through a private link; and the bundle carries a signed `capture` record of when DocuSign completed the envelope and when the copy was taken. Normalising the PDF before hashing was considered and rejected: it shrinks what the proof covers and every future verifier would need to reproduce the normalisation. See [architecture](architecture.md#the-archived-copy-is-the-document-of-record).

## Test 2: document of record and signer link (2026-10-09)

Run after the fix above was deployed (signed `capture`, completed-status check, signer links).

| Step | Result |
|---|---|
| Envelope | consulting agreement, one signer, signed from the DocuSign email |
| Completed (DocuSign) | 08:52:41.727 UTC |
| Connect delivery | 0 failures |
| Archived | 08:53:05.556 UTC (+24 s) |
| Anchored | [`CUHRBLV4DIK55RRS2AGI2GT6OOIYIUTX4VERUFRYLOHXKWEUS2IQ`](https://explorer.perawallet.app/tx/CUHRBLV4DIK55RRS2AGI2GT6OOIYIUTX4VERUFRYLOHXKWEUS2IQ), round 65815335, ledger time 08:53:06 UTC |
| Two fresh DocuSign downloads | different hashes again (expected) |

Checks through the signer link:

| Check | Expected | Result |
|---|---|---|
| Signer page `/d/<token>` | loads, `Cache-Control: no-store`, `X-Robots-Tag: noindex` | ✅ |
| Link with one character changed | 404 | ✅ |
| Downloaded PDF SHA-256 | equals `documentHash` in the bundle (`47a3150f…2979`) | ✅ |
| Bundle `capture` | present, `source: docusign-envelope-combined` | ✅ |
| **Verify now** | VALID: ML-DSA-65 signature, document hash, Merkle inclusion, Algorand anchor | ✅ |
| Signers | reported by DocuSign (`docusign-connect`), signing time matches completion | ✅ |

Attacks against the downloaded copy, run through `POST /api/verify`:

| Attack | Expected | Result |
|---|---|---|
| Original PDF + bundle | VALID | ✅ VALID |
| PDF with bytes appended | INVALID on document hash | ✅ rejected |
| `capture.capturedAt` moved back one day | INVALID on signature | ✅ rejected |

How the checks were run (any bundle and PDF pair works the same way):

```bash
# server-side
curl -s -F bundle=@bundle.json -F pdf=@document.pdf https://pq-verifiable-archive.vercel.app/api/verify

# independent, no trust in this service
npm run verify -- --bundle bundle.json --pdf document.pdf
```

## Check the anchors yourself

Each anchor transaction's note is JSON: `{"protocol":"pqva/2","op":"anchor","merkleRoot":…,"envelopeCount":…,"envelopeIdsSha256":…}`. Envelope ids are hashed, never written in clear.

```bash
curl -s https://mainnet-idx.algonode.cloud/v2/transactions/CUHRBLV4DIK55RRS2AGI2GT6OOIYIUTX4VERUFRYLOHXKWEUS2IQ \
  | jq -r '.transaction.note' | base64 -d
```

The sender must be the issuer address above. The verifier checks this, the round and the exact Merkle root.

## Live example

Once the public `/try` demo is enabled, a showcase envelope signed through it is linked from https://pq-verifiable-archive.vercel.app/try. Its PDF and bundle can be downloaded and verified by anyone. It will be recorded here as test 3.
