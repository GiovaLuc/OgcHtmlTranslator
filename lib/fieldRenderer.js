// Rendering dei campi "semplici" (non geografici): string/enum, number, e gli oggetti
// numerici (a somma vincolata o no).
// classifyField ispeziona lo schema JSON di ciascun input, non il nome del campo
// per restare valido su processi OGC futuri non ancora
// visti. I campi geografici sono gestiti in geoRenderer.js, non qui.
const { escapeHtml } = require('./template');

function jsVarName(fieldName) {
  return fieldName.replace(/[^a-zA-Z0-9_]/g, '_');
}

function isGeoConst(schema, geoType) {
  return schema && schema.type === 'object' && schema.properties &&
    schema.properties.type && schema.properties.type.const === geoType;
}

function classifyField(name, def) {
  const schema = def.schema;

  if (schema.type === 'string' && Array.isArray(schema.enum)) {
    if (schema.enum.length === 1) return 'const';
    return schema.enum.length <= 4 ? 'enum-radio' : 'enum-select';
  }
  if (schema.type === 'string') {
    return 'string';
  }
  if (schema.type === 'number') {
    return (schema.minimum !== undefined || schema.maximum !== undefined) ? 'number-range' : 'number';
  }
  if (isGeoConst(schema, 'Polygon')) {
    return 'geo-polygon';
  }
  if (isGeoConst(schema, 'Feature')) {
    return 'geo-feature';
  }
  if (isGeoConst(schema, 'FeatureCollection')) {
    const itemProps = schema.properties.features &&
      schema.properties.features.items &&
      schema.properties.features.items.properties &&
      schema.properties.features.items.properties.properties;
    const hasRequiredProp = itemProps && Array.isArray(itemProps.required) && itemProps.required.length > 0;
    return hasRequiredProp ? 'geo-featurecollection-props' : 'geo-featurecollection';
  }
  if (schema.type === 'array' && schema.items && isGeoConst({ type: 'object', properties: schema.items.properties }, 'Feature')) {
    return 'geo-feature-array';
  }
  if (schema.type === 'object' && schema.properties) {
    const props = Object.values(schema.properties);
    const allPercentages = props.length > 0 && props.every(p =>
      p.type === 'number' && p.minimum === 0 && p.maximum === 100);
    if (allPercentages) {
      return 'object-sum';
    }
    if (props.every(p => p.type === 'number')) {
      return 'object-numbers';
    }
    return 'object-plain';
  }
  throw new Error(`Unsupported field schema for "${name}": ${JSON.stringify(schema)}`);
}

// ── Simple (non-geo) field renderers ─────────────────────────────────────

function renderEnumSelect(name, def) {
  const required = def.minOccurs > 0;
  const options = def.schema.enum
    .map(v => `      <option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
    .join('\n');
  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <select name="${name}"${required ? ' required' : ''}>
      <option value="">— select —</option>
${options}
    </select>
  </div>`;
  const collect = `form.elements['${name}'].value`;
  return { html, collect };
}

// Single-value enum: no visible control, value sent as a constant in the payload.
function renderConst(name, def) {
  const value = def.schema.enum[0];
  return { html: '', constValue: value };
}

function renderEnumRadio(name, def) {
  const required = def.minOccurs > 0;
  const cards = def.schema.enum.map((v, i) => `      <div class="radio-card">
        <input type="radio" name="${name}" id="${name}_${i}" value="${escapeHtml(v)}"${i === 0 && required ? ' required' : ''}>
        <label for="${name}_${i}">${escapeHtml(v)}</label>
      </div>`).join('\n');
  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <div class="radio-card-grid">
${cards}
    </div>
  </div>`;
  const collect = `form.elements['${name}'].value`;
  return { html, collect };
}

function renderString(name, def) {
  const required = def.minOccurs > 0;
  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <input type="text" name="${name}"${required ? ' required' : ''}>
  </div>`;
  const collect = `form.elements['${name}'].value.trim()`;
  return { html, collect };
}

function renderNumber(name, def) {
  const required = def.minOccurs > 0;
  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <input type="number" name="${name}" step="0.1"${required ? ' required' : ''}>
  </div>`;
  const collect = `parseFloat(form.elements['${name}'].value)`;
  return { html, collect };
}

function renderNumberRange(name, def) {
  const required = def.minOccurs > 0;
  const { minimum, maximum } = def.schema;
  const attrs = [
    minimum !== undefined ? `min="${minimum}"` : '',
    maximum !== undefined ? `max="${maximum}"` : '',
    'step="0.1"'
  ].filter(Boolean).join(' ');
  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <input type="number" name="${name}" ${attrs}${required ? ' required' : ''}>
  </div>`;
  const collect = `parseFloat(form.elements['${name}'].value)`;
  return { html, collect };
}

function humanize(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function renderObjectSum(name, def) {
  const required = def.minOccurs > 0;
  const keys = Object.keys(def.schema.properties);
  const sumId = `${jsVarName(name)}Sum`;
  const totalId = `${jsVarName(name)}Total`;
  const items = keys.map(k => {
    const propSchema = def.schema.properties[k];
    const attrs = [
      propSchema.minimum !== undefined ? `min="${propSchema.minimum}"` : '',
      propSchema.maximum !== undefined ? `max="${propSchema.maximum}"` : '',
      'step="0.1"'
    ].filter(Boolean).join(' ');
    return `      <div class="obj-item">
        <label>${escapeHtml(humanize(k))}</label>
        <input type="number" name="${name}.${k}" ${attrs} value="0">
      </div>`;
  }).join('\n');

  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <div class="obj-grid">
${items}
    </div>
    <div class="obj-sum" id="${sumId}">Total: <strong id="${totalId}">0</strong> / 100</div>
    <span class="error-msg" id="${jsVarName(name)}Err">Values must sum to exactly 100.</span>
  </div>`;

  const varName = jsVarName(name);
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
    let ${varName}Val = 0;
    ${varName}Inputs.forEach(i => ${varName}Val += parseFloat(i.value) || 0);
    const ${varName}ErrEl = document.getElementById('${varName}Err');
    if (Math.round(${varName}Val * 10) / 10 !== 100) { ${varName}ErrEl.style.display = 'block'; valid = false; }
    else ${varName}ErrEl.style.display = 'none';`;

  const collectJs = `
    const ${varName} = {};
    ${varName}Inputs.forEach(i => { ${varName}[i.name.replace('${name}.', '')] = parseFloat(i.value) || 0; });`;

  return { html, initJs, validateJs, collectVar: varName, collectJs };
}

// Object of independent numbers (no implicit sum constraint), e.g. { temperature, precipitation, humidity, ... }
function renderObjectNumbers(name, def) {
  const required = def.minOccurs > 0;
  const requiredSub = new Set(def.schema.required || []);
  const keys = Object.keys(def.schema.properties);
  const items = keys.map(k => {
    const propSchema = def.schema.properties[k];
    const attrs = [
      propSchema.minimum !== undefined ? `min="${propSchema.minimum}"` : '',
      propSchema.maximum !== undefined ? `max="${propSchema.maximum}"` : '',
      'step="0.1"'
    ].filter(Boolean).join(' ');
    return `      <div class="obj-item">
        <label>${escapeHtml(humanize(k))}</label>
        <input type="number" name="${name}.${k}" ${attrs}${requiredSub.has(k) ? ' required' : ''}>
      </div>`;
  }).join('\n');

  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <div class="obj-grid">
${items}
    </div>
  </div>`;

  const varName = jsVarName(name);
  const collectJs = `
    const ${varName} = {};
${keys.map(k => `    ${varName}['${k}'] = parseFloat(form.elements['${name}.${k}'].value);`).join('\n')}`;

  return { html, collectVar: varName, collectJs };
}

module.exports = {
  classifyField,
  jsVarName,
  humanize,
  renderConst,
  renderEnumSelect,
  renderEnumRadio,
  renderString,
  renderNumber,
  renderNumberRange,
  renderObjectNumbers,
  renderObjectSum,
};
