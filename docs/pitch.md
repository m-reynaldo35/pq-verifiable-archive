# PQ Verifiable Archive

### A post-quantum tamper-evidence layer for DocuSign envelopes

---

## Problem

A mortgage signed today is enforceable in 2050. So are IP assignments, M&A
agreements, and clinical-trial consents. Their signatures rest on RSA and ECDSA —
algorithms a cryptographically relevant quantum computer breaks. "Harvest now,
decrypt later" is not hypothetical: adversaries are already archiving signed
artifacts to forge or repudiate them once the hardware lands. DocuSign's signature
chain has no post-quantum layer. The integrity guarantee on every long-lived
contract DocuSign processes has a known expiry date.

## Solution

A single Connect webhook integration. On envelope completion we SHA-256 the
completed PDF (never stored), Merkle-batch the hashes, and anchor the batch root in
an Algorand mainnet transaction. Each envelope gets a self-contained JSON **proof
bundle** signed with DocuSign's institutional ML-DSA-65 (FIPS-204) key. An offline
verifier CLI proves any envelope's integrity decades later — without DocuSign's
servers being up, and without trusting them. **No PII and no document content ever
touch the chain** — only irreversible hashes.

This is live today on Algorand mainnet: real transactions, real ML-DSA-65
signatures, a working verifier.

## Why Now

NIST finalised ML-DSA as FIPS-204 in August 2024 — it is now a citable standard, not
a research candidate. CNSA 2.0 mandates PQC across national-security and regulated
federal procurement by ~2030–2035, with adoption beginning well before. Finance,
healthcare, and defence customers will ask DocuSign for a post-quantum integrity
story before DocuSign has one to give. The window to lead rather than react is open
now and closes as competitors and standards bodies move.

## Why Algorand

Algorand already produces **native Falcon-512 state proofs** — a post-quantum
attestation over every block, in production today. We anchor into a chain that is
itself quantum-resistant at the consensus layer. It is public and free to query, so
verification depends on no vendor. It is permissionless, so there is no lock-in: any
party can confirm a record against the public ledger forever.

## Why ML-DSA

FIPS-204 is fully standardised and CNSA 2.0-approved — a defensible compliance claim
to a regulator or auditor. Alternatives are weaker: Falcon (FN-DSA) is not yet
finalised, and PKCS#7 PQC extensions are years out. ML-DSA-65 is the conservative,
auditable choice for an institutional key meant to outlive the document.

## Build vs. Borrow

This is a roughly four-week engineering effort that DocuSign can absorb as a product
feature — the proof-of-concept is already built. The alternatives are worse: wait on
PKCS#7 PQC extensions (multi-year, outside DocuSign's control) or stand up a custom
trusted timestamping authority (expensive, centralised, and exactly the
single-point-of-trust customers are trying to escape). Anchoring to a public PQC
chain is cheaper, faster, and more credible than building trust infrastructure
from scratch.

## The Ask

A 30-minute technical deep-dive with product and security, plus access to a DocuSign
developer sandbox so we can run the full live demo end-to-end: sign an envelope,
watch the bundle generate, and verify it offline in front of you.
