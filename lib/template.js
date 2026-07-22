// Shell HTML/CSS statica comune a tutti i form generati: head (con Leaflet/leaflet-draw/
// Turf.js CDN se servono campi geografici), stile del design system, wrapper <form> con
// i pulsanti Cancel/Run Analysis. generateHtml.js vi inietta solo bodyHtml (i campi) e
// script (la logica di validazione/raccolta payload).
const STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    background: #f8f9fa;
    color: #1a1a2e;
    padding: 20px;
  }

  h1 { font-size: 17px; font-weight: 600; margin-bottom: 4px; }
  .desc { color: #555; font-size: 13px; margin-bottom: 20px; }

  .section { margin-bottom: 18px; }
  .section-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: #3a7bd5;
    margin-bottom: 10px;
  }
  .optional-badge {
    font-size: 10px;
    font-weight: 500;
    color: #888;
    background: #f0f0f0;
    border-radius: 4px;
    padding: 1px 5px;
    margin-left: 6px;
    vertical-align: middle;
    text-transform: none;
    letter-spacing: 0;
  }

  label { display: block; font-weight: 500; margin-bottom: 4px; font-size: 13px; }
  label .req { color: #e53e3e; margin-left: 2px; }
  .hint { font-size: 11px; color: #888; margin-bottom: 6px; }

  select, input[type="text"], input[type="number"] {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font-size: 13px;
    background: #fff;
    color: #1a1a2e;
    margin-bottom: 12px;
    transition: border-color .15s;
  }
  select:focus, input:focus {
    outline: none;
    border-color: #3a7bd5;
    box-shadow: 0 0 0 3px rgba(58,123,213,.12);
  }

  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }

  /* Radio cards (enum <= 4 options) */
  .radio-card-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 12px;
  }
  .radio-card { position: relative; cursor: pointer; }
  .radio-card input[type="radio"] { position: absolute; opacity: 0; width: 0; height: 0; }
  .radio-card label {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    border: 2px solid #d0d7de;
    border-radius: 8px;
    background: #fff;
    cursor: pointer;
    transition: border-color .15s, background .15s;
    font-weight: 400;
    margin-bottom: 0;
  }
  .radio-card input[type="radio"]:checked + label {
    border-color: #3a7bd5;
    background: #f0f4ff;
  }

  /* Object numeric fields with constrained sum */
  .obj-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 14px;
  }
  .obj-item label { font-weight: 400; }
  .obj-sum {
    font-size: 12px;
    margin-top: 6px;
    padding: 6px 10px;
    border-radius: 5px;
    background: #f0f4ff;
  }
  .obj-sum.ok { background: #e6ffed; color: #276749; }
  .obj-sum.err { background: #fff5f5; color: #c53030; }

  /* Map */
  .map-wrap { position: relative; margin-bottom: 6px; }
  .map-container { height: 340px; width: 100%; max-width: 100%; overflow: hidden; border: 1px solid #d0d7de; border-radius: 8px; position: relative; }
  .map-container.phase-active { border-color: #3a7bd5; }

  .map-hint {
    font-size: 11px;
    padding: 6px 10px;
    border-radius: 6px;
    margin-bottom: 10px;
    background: #f0f4ff;
    color: #3a7bd5;
  }

  .btn-done-overlay {
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 1000;
    padding: 9px 16px;
    border: none;
    border-radius: 20px;
    background: #3a7bd5;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.25);
    transition: opacity .15s, transform .15s;
  }
  .btn-done-overlay:hover { opacity: .92; transform: translateY(-1px); }

  /* Phase switcher (multiple geo fields in one process) */
  .phase-bar {
    display: flex;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .phase-btn {
    flex: 1;
    padding: 9px 12px;
    border: none;
    background: #f5f7fa;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    color: #555;
    transition: background .15s, color .15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .phase-btn:not(:last-child) { border-right: 1px solid #d0d7de; }
  .phase-btn.active { background: #3a7bd5; color: #fff; }
  .phase-btn.done { background: #e6ffed; color: #276749; }
  .phase-btn:disabled { opacity: .5; cursor: default; }

  /* Multi-feature list (measures / canopy / etc.) */
  .feature-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
  .feature-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
  }
  .feature-swatch { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }
  .feature-label { flex: 1; font-size: 13px; color: #444; }
  .feature-prop-input { width: 90px; margin-bottom: 0; text-align: center; }
  .btn-remove-feature {
    background: none;
    border: none;
    color: #c53030;
    font-size: 16px;
    cursor: pointer;
    padding: 0 2px;
    font-weight: 700;
    line-height: 1;
  }

  .btn-add {
    width: 100%;
    padding: 8px;
    border: 2px dashed #b0bec5;
    border-radius: 8px;
    background: none;
    color: #555;
    font-size: 13px;
    cursor: pointer;
    transition: border-color .15s, color .15s;
    margin-top: 6px;
  }
  .btn-add:hover:not(:disabled) { border-color: #3a7bd5; color: #3a7bd5; }
  .btn-add:disabled { opacity: .5; cursor: default; }

  .actions { display: flex; gap: 10px; margin-top: 20px; }
  button.btn-submit, button.btn-cancel {
    padding: 9px 20px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: opacity .15s;
  }
  button:hover { opacity: .88; }
  .btn-submit { background: #3a7bd5; color: #fff; flex: 1; }
  .btn-cancel { background: #e2e8f0; color: #444; }

  .error-msg { color: #c53030; font-size: 12px; margin-bottom: 8px; display: none; }
`;

const LEAFLET_HEAD = `
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js"></script>
<script src="https://unpkg.com/@turf/turf@6.5.0/turf.min.js"></script>
`;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPage({ title, description, needsLeaflet, bodyHtml, script }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>${needsLeaflet ? LEAFLET_HEAD : ''}
<style>${STYLE}</style>
</head>
<body>

<h1>${escapeHtml(title)}</h1>
<p class="desc">${escapeHtml(description || '')}</p>

<form id="analysisForm" novalidate>
${bodyHtml}
  <div class="actions">
    <button type="button" class="btn-cancel" onclick="cancel()">Cancel</button>
    <button type="submit" class="btn-submit">Run Analysis</button>
  </div>

</form>

<script>
${script}

function cancel() {
  window.parent.postMessage({ type: 'analysis-cancel' }, '*');
}
</script>
</body>
</html>
`;
}

module.exports = { renderPage, escapeHtml };
