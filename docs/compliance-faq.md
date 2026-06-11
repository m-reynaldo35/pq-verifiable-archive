# Compliance FAQ — PQ Verifiable Archive

For DocuSign Legal, GRC, and Privacy reviewers. Direct answers to the questions a
compliance review will raise.

---

### Does anything personally identifiable go on-chain?

No. The only data written to Algorand is a SHA-256 Merkle root — a 32-byte
irreversible hash of hashes. SHA-256 is a one-way function; the document and its
contents cannot be reconstructed from it. Under GDPR Recital 26, irreversibly
anonymised data is not personal data and falls outside the Regulation. No document
content, no signer names, no email addresses are anchored.

### What data is in the proof bundle, and where does it live?

The proof bundle is a JSON file held **by DocuSign** (stored alongside the envelope,
or delivered to signers) — it is not published on-chain. It contains:

- the document's SHA-256 hash,
- the Merkle proof connecting that hash to the anchored batch root,
- the Algorand transaction ID and confirmed round,
- signer identity fields (name, email, signed-at timestamp), and
- DocuSign's ML-DSA-65 signature over all of the above.

The signer identity fields are the same data DocuSign already stores for every
envelope today. Anchoring adds no new collection.

### Who controls the ML-DSA private key?

DocuSign. It is DocuSign's institutional signing key. In production it is held in an
HSM under DocuSign's existing key-management controls. In the proof-of-concept it is
loaded from an environment variable. The corresponding public key is registered once
on-chain so any verifier can confirm signatures without contacting DocuSign.

### What happens if Algorand goes down or ceases to exist?

Signing does not depend on Algorand being live — the chain is only consulted during
*verification*, not during the signing/anchoring flow. Proof bundles are
self-contained and DocuSign-held. For verification, any Algorand node can serve the
historical transaction; the public AlgoNode API is the default, and any indexer
mirroring mainnet history is an equivalent fallback. The on-chain record is
immutable and permanent once confirmed.

### Is ML-DSA a recognised standard?

Yes. ML-DSA is NIST FIPS-204, finalised August 2024, and is approved under CNSA 2.0
for national-security systems. We use ML-DSA-65 (the NIST security category 3
parameter set). This is a citable, auditable standard — not a research candidate.

### What is the audit trail for a given envelope?

For every envelope, the bundle yields:

1. an Algorand transaction ID with a block timestamp (independently verifiable on a
   public ledger),
2. an ML-DSA-65 signature over the signer identity and document hash, and
3. a Merkle proof showing the document's inclusion in that anchored batch.

Each element is independently checkable by a third party using only public
infrastructure and the bundle.

### How does key rotation work? Does it invalidate old bundles?

Rotation is additive. A new on-chain `key-register` transaction records the new
public-key fingerprint. Bundles signed under the old key remain valid and verifiable
against the old registered public key — the verifier resolves the key referenced by
each bundle. No re-signing of historical archives is required.

### How does this interact with the GDPR right to erasure?

The bundle holds a hash plus envelope metadata. The hash is not erasable (it is
anchored immutably) but it is **not personal data** — it is irreversible and
identifies nothing on its own. The signer name and email in the bundle are stored by
DocuSign in the same systems and under the same retention and erasure policies as the
existing envelope record; an erasure request is handled exactly as it is for the
envelope today. The on-chain anchor contains no erasable personal data because it
contains no personal data at all.

### Does this change the legal status of the e-signature?

No. This is a long-term integrity *anchor* layered on top of the existing signature.
It does not replace DocuSign's signing UX, identity verification, or the legal
e-signature itself, and it makes no claim that the underlying e-signature is
quantum-proof. It proves, decades later and without trusting any single vendor, that
a specific document was sealed at a specific time by DocuSign's institutional key.
