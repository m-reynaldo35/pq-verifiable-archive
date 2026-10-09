'use strict';

const EXPLORER_TX_BASE = 'https://explorer.perawallet.app/tx/';

const STEP_SUBTITLES = {
  'ML-DSA-65 Signature': 'Receipt signed by the trusted issuer (post-quantum signature)',
  'Document Hash': 'Document fingerprint match',
  'Merkle Inclusion': 'Document hash is committed under the anchored root',
  'Algorand Anchor': 'Issuer\'s ledger record confirmed (sender, round, note)',
  'State Proof (indexer-reported)': 'Whether the indexer lists a covering state-proof txn (not cryptographically checked)',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Verify step detail looks like "<txId> (round N, ...)"; link the leading txId.
function explorerLink(detail) {
  const m = detail.match(/^([A-Z0-9]{20,})\s*(.*)$/);
  if (!m) return esc(detail);
  const txId = m[1];
  return '<a href="' + EXPLORER_TX_BASE + esc(txId) +
    '" target="_blank" rel="noopener">' + esc(txId) + '</a> ' + esc(m[2]);
}

function renderSteps(steps, container) {
  container.innerHTML = '';
  for (const s of steps) {
    const isInfo = Boolean(s.informational);
    const row = document.createElement('div');
    let iconClass, iconChar, stateClass;
    if (isInfo) {
      iconClass = 'info'; iconChar = 'i'; stateClass = ' info';
    } else if (s.skipped) {
      iconClass = 'skip'; iconChar = '–'; stateClass = ' skip';
    } else if (s.error) {
      iconClass = 'error'; iconChar = '!'; stateClass = '';
    } else if (s.passed) {
      iconClass = 'pass'; iconChar = '✓'; stateClass = '';
    } else {
      iconClass = 'fail'; iconChar = '✗'; stateClass = '';
    }
    row.className = 'step' + stateClass;
    const tag = isInfo ? '<span class="tag">Informational</span>' : '';
    const subtitle = STEP_SUBTITLES[s.name]
      ? '<div class="subname">' + esc(STEP_SUBTITLES[s.name]) + '</div>' : '';
    const detailHtml = s.name === 'Algorand Anchor' && s.passed
      ? explorerLink(s.detail) : esc(s.detail);
    row.innerHTML =
      '<div class="icon ' + iconClass + '">' + iconChar + '</div>' +
      '<div class="body"><div class="name">' + esc(s.name) + tag + '</div>' +
      subtitle +
      '<div class="detail">' + detailHtml + '</div></div>';
    container.appendChild(row);
  }
}

function renderBanner(result, container) {
  const steps = result.steps || [];
  const failing = steps.filter(s => !s.informational && !s.passed);
  const operationalError = result.operationalError ?? (failing.length > 0 && failing.every(s => s.error));
  const documentChecked = result.documentChecked ?? !steps.some(s => s.skipped);
  const asOf = result.anchoredAt ? ' · anchored ' + result.anchoredAt + ' (ledger time)' : '';

  if (result.valid) {
    container.className = 'banner valid';
    if (documentChecked) {
      container.innerHTML = 'VALID ✓ — document matches the issuer\'s anchored record' +
        '<span class="sub">Signature, issuer key and on-chain anchor confirmed' + esc(asOf) + '</span>';
    } else {
      container.innerHTML = 'BUNDLE VALID — document not checked' +
        '<span class="sub">The receipt is authentic' + esc(asOf) + ', but no document was supplied. Upload the original to check it.</span>';
    }
    return;
  }
  if (operationalError) {
    container.className = 'banner warn';
    container.innerHTML = 'COULD NOT VERIFY<span class="sub">Network or configuration error — try again later.</span>';
    return;
  }
  container.className = 'banner invalid';
  container.innerHTML = 'INVALID ✗<span class="sub">One or more verification checks failed.</span>';
}

function renderSigners(signers, container) {
  container.innerHTML = '';
  for (const s of signers) {
    const el = document.createElement('div');
    el.className = 'signer';
    el.innerHTML =
      '<div class="sname">' + esc(s.name) + '</div>' +
      '<div class="smeta">' + esc(s.email) + ' — signed ' + esc(s.signedAt) + '</div>';
    container.appendChild(el);
  }
}

// Signed gap between two ISO times; mirrors src/captureSummary.ts.
function formatCaptureGap(fromIso, toIso) {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return 'gap unknown';
  const s = Math.round(Math.abs(ms) / 1000);
  const span = s < 120 ? s + ' s' : s < 7200 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h';
  return ms >= 0 ? '+' + span + ' after completion' : span + ' BEFORE completion';
}

// The bundle's signed capture record. Hidden unless the issuer's signature
// checked out, since an unsigned or forged record says nothing.
function renderCapture(result, container) {
  const c = result.capture;
  const signatureOk = (result.steps || []).some(s => s.name === 'ML-DSA-65 Signature' && s.passed);
  if (!c || !signatureOk) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  const row = (label, value) =>
    '<div class="smeta"><span class="clabel">' + esc(label) + '</span> ' + esc(value) + '</div>';
  container.style.display = 'block';
  container.innerHTML =
    '<div class="section-title">Document capture</div>' +
    '<div class="signer">' +
      row('DocuSign reported completion:', c.envelopeCompletedAt) +
      row('Issuer archived this copy:', c.capturedAt + ' (' + formatCaptureGap(c.envelopeCompletedAt, c.capturedAt) + ')') +
      (result.anchoredAt ? row('Anchored on Algorand (ledger time):', result.anchoredAt) : '') +
      '<div class="smeta cnote">Signed by the issuer. The first two times come from DocuSign and the issuer; ' +
      'the ledger time is the independent one. A fresh download from DocuSign will not match this copy, ' +
      'because DocuSign regenerates the PDF on every download.</div>' +
    '</div>';
}
