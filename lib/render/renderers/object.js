// Renderizza gli schemi `object` con proprietà numeriche scalari: sotto-campi
// indipendenti (object-numbers), o un gruppo a somma vincolata con proprio script live-sum (object-sum).
// Pipeline: instradato qui da classifyField di fieldRenderer.js; object-sum è l'unica eccezione al contratto generico di formEngine.js.
const { escapeHtml } = require('../template');
const { humanize, jsVarName } = require('./section');

function renderObjectNumbers(name, def) {
  const required = def.minOccurs > 0;
  const requiredSub = new Set(def.schema.required || []);
  const keys = Object.keys(def.schema.properties);
  const items = keys.map(k => {
    const propSchema = def.schema.properties[k];
    const attrs = [
      propSchema.minimum !== undefined ? `min="${propSchema.minimum}"` : '',
      propSchema.maximum !== undefined ? `max="${propSchema.maximum}"` : '',
      propSchema.type === 'integer' ? 'step="1"' : 'step="any"',
    ].filter(Boolean).join(' ');
    const fieldName = `${name}.${k}`;
    return `      <div class="obj-item">
        <label for="${fieldName}">${escapeHtml(humanize(k))}</label>
        <input type="number" name="${fieldName}" id="${fieldName}" ${attrs}${requiredSub.has(k) ? ' required' : ''}>
      </div>`;
  }).join('\n');

  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <div class="obj-grid">
${items}
    </div>
  </div>`;
  return { html };
}

function renderObjectSum(name, def) {
  const required = def.minOccurs > 0;
  const keys = Object.keys(def.schema.properties);
  const varName = jsVarName(name);
  const sumId = `${varName}Sum`;
  const totalId = `${varName}Total`;

  const items = keys.map(k => {
    const propSchema = def.schema.properties[k];
    const attrs = [
      propSchema.minimum !== undefined ? `min="${propSchema.minimum}"` : '',
      propSchema.maximum !== undefined ? `max="${propSchema.maximum}"` : '',
      'step="any"',
    ].filter(Boolean).join(' ');
    return `      <div class="obj-item">
        <label>${escapeHtml(humanize(k))}</label>
        <input type="number" name="${name}.${k}" data-geo-field ${attrs} value="0">
      </div>`;
  }).join('\n');
  // data-geo-field here just tells the generic engine (formEngine.js) to skip these
  // inputs — they're collected below by this renderer's own dedicated script instead,
  // same opt-out mechanism used for map-drawn geo fields.

  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <div class="obj-grid">
${items}
    </div>
    <div class="obj-sum" id="${sumId}">Total: <strong id="${totalId}">0</strong> / 100</div>
    <span class="error-msg" id="${varName}Err">Values must sum to exactly 100.</span>
  </div>`;

  const initJs = `
  const ${varName}Inputs = document.querySelectorAll('[name^="${name}."]');
  const ${varName}SumEl = document.getElementById('${sumId}');
  const ${varName}TotalEl = document.getElementById('${totalId}');
  function update${varName}Sum() {
    let total = 0;
    ${varName}Inputs.forEach(i => total += parseFloat(i.value) || 0);
    total = Math.round(total * 10) / 10;
    ${varName}TotalEl.textContent = total;
    ${varName}SumEl.className = 'obj-sum ' + (total === 100 ? 'ok' : total > 100 ? 'err' : '');
  }
  ${varName}Inputs.forEach(i => i.addEventListener('input', update${varName}Sum));
  update${varName}Sum();`;

  const validateJs = `
  {
    let ${varName}Val = 0;
    ${varName}Inputs.forEach(i => ${varName}Val += parseFloat(i.value) || 0);
    const ${varName}ErrEl = document.getElementById('${varName}Err');
    if (Math.round(${varName}Val * 10) / 10 !== 100) { ${varName}ErrEl.style.display = 'block'; valid = false; }
    else ${varName}ErrEl.style.display = 'none';
  }`;

  const collectExpr = `(() => { const o = {}; ${varName}Inputs.forEach(i => { o[i.name.replace('${name}.', '')] = parseFloat(i.value) || 0; }); return o; })()`;

  return { html, initJs, validateJs, collectExprs: { [name]: collectExpr } };
}

module.exports = { renderObjectNumbers, renderObjectSum };
