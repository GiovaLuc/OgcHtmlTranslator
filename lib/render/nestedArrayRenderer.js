// Assembla il motore nested-array lato browser a partire da client/nestedArrayEngine.
// client.js (JS browser puro, letto via fs.readFileSync) più i descrittori campo della pagina.
// Pipeline: chiamato da generateHtml.js per un campo con role "nested-array" (vedi
// lib/llm/sanitizeLlmGeoField.js) — produce HTML + initJs + collectExpr + validateJs,
// nello stesso formato di ogni altro renderer in lib/render/renderers/.
const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('./template');
const { jsVarName } = require('./renderers/section');

const CLIENT_SOURCE = fs.readFileSync(
  path.join(__dirname, 'client', 'nestedArrayEngine.client.js'), 'utf8'
);

function renderNestedArrayField(name, def, nestedArrayShape) {
  const required = def.minOccurs > 0;
  const varName = jsVarName(name);
  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <div id="nested_${varName}" class="nested-container"></div>
    <span class="error-msg" id="nestedErr_${varName}">At least one entry is required at every level, with every value filled in.</span>
  </div>`;

  const field = { name, varName, title: def.title, ...nestedArrayShape };
  const validateJs = `  if (window.__nestedArrayEngine && !window.__nestedArrayEngine.validate()) valid = false;`;
  const collectExprs = { [name]: `window.__nestedArrayEngine.collectValue(${JSON.stringify(name)})` };

  return { html, field, validateJs, collectExprs };
}

// Called once per page (not once per field, unlike renderNestedArrayField) — bundles
// the client engine source with every nested-array field descriptor collected across
// the whole process, same pattern as lib/render/geoFieldEngine.js's shared map script.
function buildNestedArrayEngineScript(fields) {
  if (!fields || fields.length === 0) return '';
  return `${CLIENT_SOURCE}\ninitNestedArrayFields(${JSON.stringify(fields)});`;
}

module.exports = { renderNestedArrayField, buildNestedArrayEngineScript };
