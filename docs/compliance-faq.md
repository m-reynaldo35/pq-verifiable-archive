# Compliance FAQ — PQ Verifiable Archive

Direct answers to the questions a legal, GRC or privacy review will raise. Each
answer describes what the code in this repository does today.

---

### Who is the issuer, and who controls the ML-DSA private key?

The **operator of the service** — whoever runs `src/server.ts` or the MCP server.
That operator holds the ML-DSA-65 private key and the Algorand wallet mnemonic in
environment variables (`PQVA_MLDSA_PRIVATE_KEY`, `ALGORAND_MNEMONIC`). DocuSign is not
the issuer and has no role in signing; the DocuSign integration only receives
completed envelopes through a Connect webhook.

The operator's Algorand address is the **issuer address**. It sends a one-time
`key-register` transaction recording the SHA-256 fingerprint of its ML-DSA public
key, and it sends every anchor transaction. Verifiers pin the issuer address (and,
optionally, the key fingerprint); they never take it from the bundle.

A production deployment should hold the private key in an HSM or KMS rather than an
environment variable. This repository does not do that yet.

### Does anything personally identifiable go on-chain?

No names, emails or document content are written on-chain. Each anchor transaction's
note contains:

- `merkleRoot` — for a single document this is `SHA-256(0x00 || SHA-256(document))`,
- `envelopeCount` and `envelopeIdsSha256` — a SHA-256 over the envelope identifier(s).

These values are **pseudonymous, not anonymous**. Anyone who holds a copy of the
document (or can guess the envelope identifier) can recompute the hashes and confirm
that it was anchored, and when. Under GDPR, data that can be linked back with
additional information is still personal data where it relates to an identifiable
person. Treat the on-chain anchor as pseudonymised data in a DPIA, not as data outside
the Regulation.

### What data is in the proof bundle, and where does it live?

The bundle is a JSON file returned to whoever requested the anchor and, for the
archive and webhook paths, stored by the operator in a private Vercel Blob store. It is not
published on-chain. It contains:

- the document's SHA-256 hash,
- the Merkle proof connecting it to the anchored root,
- the Algorand transaction ID and confirmed round,
- the issuer address and key-registration transaction ID,
- an optional signer list (name, email, signed-at) with a `signerSource`,
- the issuer's ML-DSA-65 public key and signature over all of the above.

The archive also stores the uploaded **PDF itself** (private Vercel Blob store,
served only through the API-key-protected endpoints), so the operator's normal
retention, access-control and erasure policies apply to it.

### What does the signer list prove?

It depends on `signerSource`:

- `docusign-connect` — the operator read the signers from DocuSign's API after an
  HMAC-verified Connect webhook, using only recipients with a `signedDateTime`.
- `requester-asserted` — whoever called `/api/anchor`, `/api/archive` or the MCP tool
  typed the list. The bundle proves the requester **claimed** these signers; the
  issuer did not verify them.

All verifiers in this repository label requester-asserted signers as unverified.

### What happens if Algorand or the default indexer goes away?

Anchoring needs Algorand to be live: every bundle is signed *after* its anchor
transaction confirms. Verification needs:

- **No network** for the signature (when the verifier pins the issuer key
  fingerprint), the document hash and the Merkle proof.
- **An archival Algorand indexer** for the anchor check. The public AlgoNode
  indexer is the default; any archival indexer works (`--indexer`). The verifier
  trusts the indexer's answer: it checks the anchor's sender, round and note, but
  does not verify a ledger proof of the transaction.

### Is ML-DSA a recognised standard?

Yes. ML-DSA is NIST FIPS-204 (August 2024), approved under CNSA 2.0. This project
uses ML-DSA-65 (security category 3) via `@noble/post-quantum`.

### What about Algorand's Falcon-512 state proofs?

Algorand produces Falcon-512 state proofs about every 256 rounds. The verifier only
reports, as **informational**, whether the indexer lists a state-proof transaction
whose attested range covers the anchor round. It does not verify the Falcon-512 proof,
nor a proof linking the anchor transaction to it. Do not rely on it as a security
property of this tool.

### What is the audit trail for a given document?

1. An ML-DSA-65 signature by the pinned issuer key over the bundle.
2. A Merkle proof from the document hash to the anchored root.
3. An Algorand transaction, sent by the issuer address in the stated round, whose
   note contains exactly that root. The ledger round time is the anchoring time.

### How does key rotation work?

The issuer sends a new `key-register` transaction from the same issuer address and
starts putting the new transaction ID in `keyRegistrationTxnId`. A verifier accepts a
key if its fingerprint matches the pinned fingerprint, or if the registration
transaction named in the bundle was sent by the pinned issuer address and records that
key's fingerprint. Old bundles keep verifying; no re-signing is needed. Rotating the
issuer **address** requires verifiers to update their pinned address.

### How does this interact with the GDPR right to erasure?

The on-chain note cannot be erased. Because it is pseudonymous (see above), assess
whether anchoring a given document is compatible with erasure obligations before
anchoring it. Bundles and archived PDFs held by the operator can be deleted under the
operator's normal processes.

### Does this change the legal status of the e-signature?

No. This is an integrity anchor layered on top of an existing signature. It does not
replace the e-signature, identity verification or the signing UX, and it makes no
claim that the underlying e-signature is quantum-resistant. It shows that a specific
document hash was anchored by a specific issuer at a specific ledger time.
