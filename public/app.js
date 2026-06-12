'use strict';

const EXPLORER_TX_BASE = 'https://explorer.perawallet.app/tx/';

const STEP_SUBTITLES = {
  'ML-DSA-65 Signature': 'Receipt authenticity (quantum-safe signature)',
  'PDF Hash': 'Document fingerprint match',
  'Merkle Inclusion': 'Document is in the sealed batch',
  'Algorand Anchor': 'Public ledger record confirmed',
  'State Proof': 'Quantum-safe network attestation (~17 min after anchoring)',
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
    const isInfo = s.name === 'State Proof';
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
  const hasSkipped = steps.some(s => s.skipped);
  const failing = steps.filter(s => s.name !== 'State Proof' && !s.passed);
  const operationalError = failing.length > 0 && failing.every(s => s.error);

  if (result.valid) {
    container.className = 'banner valid';
    const sub = hasSkipped
      ? 'Original document not verified — upload the PDF to complete verification'
      : 'On-chain record confirmed. DocuSign attestation verified offline.';
    container.innerHTML = 'VALID ✓ — record confirmed<span class="sub">' + sub + '</span>';
    return;
  }
  if (operationalError) {
    container.className = 'banner warn';
    container.innerHTML = 'COULD NOT VERIFY<span class="sub">Network or configuration error — try again or check the server.</span>';
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
