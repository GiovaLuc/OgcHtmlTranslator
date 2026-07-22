// Orchestratore: per ogni campo di process.inputs decide il tipo (fieldRenderer.classifyField),
// delega il rendering al modulo giusto (fieldRenderer per i campi semplici, geoRenderer per
// quelli geografici) e assembla script/HTML finali con template.renderPage. Le regole di
// traduzione applicate qui sono documentate in data/form-field-mapping.md.
const { renderPage } = require('./template');
const fieldRenderer = require('./fieldRenderer');
const { describeGeoField, renderGeoFields } = require('./geoRenderer');

const GEO_KINDS = new Set([
  'geo-polygon', 'geo-feature', 'geo-featurecollection',
  'geo-featurecollection-props', 'geo-feature-array',
]);

function generateHtml(process) {
  if (!process || typeof process !== 'object') {
    throw new Error('Request body must be an OGC process object');
  }
  const { title, description, id, inputs } = process;
  if (!id || !inputs || typeof inputs !== 'object') {
    throw new Error('Process must have "id" and "inputs"');
  }

  const nonGeoSections = [];
  const initJsParts = [];
  const validateJsParts = [];
  const collectStatements = [];
  const geoFieldNames = [];
  let needsLeaflet = false;

  const entries = Object.entries(inputs);
  const geoDefs = [];

  for (const [name, def] of entries) {
    const kind = fieldRenderer.classifyField(name, def);

    if (GEO_KINDS.has(kind)) {
      geoDefs.push({ name, def, kind });
      geoFieldNames.push(name);
      continue;
    }

    if (kind === 'const') {
      const rendered = fieldRenderer.renderConst(name, def);
      collectStatements.push(`    payload['${name}'] = ${JSON.stringify(rendered.constValue)};`);
      continue;
    }

    let rendered;
    switch (kind) {
      case 'enum-select':
        rendered = fieldRenderer.renderEnumSelect(name, def);
        break;
      case 'enum-radio':
        rendered = fieldRenderer.renderEnumRadio(name, def);
        break;
      case 'string':
        rendered = fieldRenderer.renderString(name, def);
        break;
      case 'number':
        rendered = fieldRenderer.renderNumber(name, def);
        break;
      case 'number-range':
        rendered = fieldRenderer.renderNumberRange(name, def);
        break;
      case 'object-sum':
        rendered = fieldRenderer.renderObjectSum(name, def);
        break;
      case 'object-numbers':
        rendered = fieldRenderer.renderObjectNumbers(name, def);
        break;
      default:
        throw new Error(`Unhandled field kind "${kind}" for field "${name}"`);
    }

    nonGeoSections.push(rendered.html);
    if (rendered.initJs) initJsParts.push(rendered.initJs);
    if (rendered.validateJs) validateJsParts.push(rendered.validateJs);

    if (rendered.collectJs) {
      collectStatements.push(rendered.collectJs);
      collectStatements.push(`    payload['${name}'] = ${rendered.collectVar};`);
    } else {
      const required = def.minOccurs > 0;
      if (required) {
        collectStatements.push(`    payload['${name}'] = ${rendered.collect};`);
      } else {
        collectStatements.push(`    { const v = ${rendered.collect}; if (v !== '' && v !== null && !(typeof v === 'number' && isNaN(v))) payload['${name}'] = v; }`);
      }
    }
  }

  let geoSection = '';
  if (geoDefs.length > 0) {
    needsLeaflet = true;
    const UNION_KINDS = new Set(['geo-polygon', 'geo-feature', 'geo-featurecollection']);
    const CONTAINED_KINDS = new Set(['geo-featurecollection-props', 'geo-feature-array']);
    const unionField = geoDefs.find(d => UNION_KINDS.has(d.kind));

    const geoFields = geoDefs.map(({ name, def, kind }) => {
      const opts = {};
      if (unionField && CONTAINED_KINDS.has(kind) && name !== unionField.name) {
        opts.containerVarName = fieldRenderer.jsVarName(unionField.name);
      }
      return describeGeoField(name, def, kind, opts);
    });
    const geoResult = renderGeoFields(geoFields);
    geoSection = geoResult.html;
    initJsParts.push(geoResult.initJs);
    validateJsParts.push(geoResult.validateJs);
    for (const [fieldName, expr] of Object.entries(geoResult.collectExprs)) {
      collectStatements.push(`    payload['${fieldName}'] = ${expr};`);
    }
  }

  const bodyHtml = geoSection + nonGeoSections.join('\n');

  const script = `
${initJsParts.join('\n')}

document.getElementById('analysisForm').addEventListener('submit', function(e) {
  e.preventDefault();
  const form = this;
  let valid = true;
${validateJsParts.join('\n')}

  if (!valid) return;

  const payload = {};
${collectStatements.join('\n')}

  window.parent.postMessage({
    type: 'analysis-submit',
    analysisId: '${id}',
    data: payload
  }, '*');
});
`;

  return renderPage({
    title: title || 'Analysis',
    description,
    needsLeaflet,
    bodyHtml,
    script,
  });
}

module.exports = { generateHtml };
