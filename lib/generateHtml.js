// Classifica ogni campo e lo renderizza, degradando a una textarea JSON grezza se un
// campo fallisce, così un campo problematico non blocca mai l'intera pagina.
// Pipeline: punto d'ingresso principale — chiama lib/classify, poi lib/llm come fallback, poi lib/render per assemblare la pagina finale.
const { renderPage } = require('./render/template');
const fieldRenderer = require('./classify/fieldRenderer');
const { renderFieldWithOllama, renderGeoFieldWithOllama } = require('./llm/ollamaRenderer');
const { describeGeoField, renderGeoFields, kindFromLlmGeoClassification } = require('./render/geoRenderer');
const { renderNestedArrayField, buildNestedArrayEngineScript } = require('./render/nestedArrayRenderer');

const GEO_KINDS = new Set([
  'geo-polygon', 'geo-feature', 'geo-featurecollection',
  'geo-featurecollection-props', 'geo-feature-array', 'geo-bbox',
]);

async function generateHtml(process, { model } = {}) {
  if (!process || typeof process !== 'object') {
    throw new Error('Request body must be an OGC process object');
  }
  const { title, description, id, inputs } = process;
  if (!id || !inputs || typeof inputs !== 'object') {
    throw new Error('Process must have "id" and "inputs"');
  }

  const log = [];
  const nonGeoSections = [];
  const initJsParts = [];
  const validateJsParts = [];
  const collectExprs = {};
  const geoDefs = [];
  const nestedArrayFields = [];
  let needsLeaflet = false;

  const entries = Object.entries(inputs);
  const allFieldNames = entries.map(([name]) => name);

  for (const [name, def] of entries) {
    const startedAt = Date.now();

    // classifyField AND renderField both run inside this try: a oneOf/anyOf/allOf
    // field can classify fine at the top level but still throw deeper down, when
    // renderOneOf recursively classifies/renders one of its alternatives (e.g. an
    // alternative shaped like {"properties": {"foo": {"const": "bar"}}}, which isn't
    // any known pattern on its own). Catching only classifyField's own throw would
    // let that inner failure escape uncaught and crash the whole page for one field.
    try {
      const kind = fieldRenderer.classifyField(name, def);

      if (kind === 'geo-unknown') {
        await handleUnknownGeoField(name, def);
        continue;
      }

      if (GEO_KINDS.has(kind)) {
        geoDefs.push({ name, def, kind });
        log.push({ field: name, source: 'static', kind, durationMs: Date.now() - startedAt });
        continue;
      }

      const rendered = fieldRenderer.renderField(name, def);
      if (kind === 'const') {
        collectExprs[name] = JSON.stringify(rendered.constValue);
      } else {
        nonGeoSections.push(rendered.html);
        if (rendered.initJs) initJsParts.push(rendered.initJs);
        if (rendered.validateJs) validateJsParts.push(rendered.validateJs);
        Object.assign(collectExprs, rendered.collectExprs || {});
      }
      log.push({ field: name, source: 'static', kind, durationMs: Date.now() - startedAt });
    } catch (err) {
      await handleUnsupportedField(name, def);
    }
  }

  // Tries Ollama for one field the static classifier rejected; degrades to the raw
  // JSON textarea (never an error) if that also fails or produces invalid output.
  async function handleUnsupportedField(name, def) {
    const startedAt = Date.now();
    const otherFieldNames = allFieldNames.filter(n => n !== name);
    try {
      const { html, model: usedModel } = await renderFieldWithOllama(name, def, process, otherFieldNames, { model });
      nonGeoSections.push(html);
      log.push({ field: name, source: 'llm', model: usedModel, durationMs: Date.now() - startedAt });
    } catch (err) {
      const rendered = fieldRenderer.renderTextareaRaw(name, def);
      nonGeoSections.push(rendered.html);
      log.push({ field: name, source: 'fallback', error: err.message, durationMs: Date.now() - startedAt });
    }
  }

  // Same idea as handleUnsupportedField, but for a field the static classifier
  // recognized as geometry-shaped (kind 'geo-unknown') without knowing which of the
  // map's roles it plays. Asks Ollama to classify (not render) it via
  // lib/ollamaGeoPrompt.js, normalizes the result onto a known synthetic geo kind, and
  // queues it into geoDefs — so it ends up on the SAME shared map/phase-bar as every
  // statically-recognized geo field, not a standalone control. Falls back to the raw
  // JSON textarea (outside the map) if classification fails or doesn't validate.
  async function handleUnknownGeoField(name, def) {
    const startedAt = Date.now();
    const otherFieldNames = allFieldNames.filter(n => n !== name);
    try {
      const classification = await renderGeoFieldWithOllama(name, def, process, otherFieldNames, { model });

      // "nested-array": neither the static classifier nor the model's role/wrapper
      // vocabulary fits, but the model described the field's own bare-array shape well
      // enough to build a plain nested-list editor instead of a raw JSON textarea (see
      // sanitizeLlmGeoField.js). Not a map field — skips geoDefs entirely.
      if (classification.role === 'nested-array') {
        const rendered = renderNestedArrayField(name, def, classification.nestedArrayShape);
        nonGeoSections.push(rendered.html);
        nestedArrayFields.push(rendered.field);
        validateJsParts.push(rendered.validateJs);
        Object.assign(collectExprs, rendered.collectExprs);
        log.push({ field: name, source: 'llm-geo-nested', model: classification.model, durationMs: Date.now() - startedAt });
        return;
      }

      const kind = kindFromLlmGeoClassification(classification);
      geoDefs.push({ name, def, kind, llmClassification: classification });
      log.push({ field: name, source: 'llm-geo', model: classification.model, kind, durationMs: Date.now() - startedAt });
    } catch (err) {
      const rendered = fieldRenderer.renderTextareaRaw(name, def);
      nonGeoSections.push(rendered.html);
      log.push({ field: name, source: 'fallback', error: err.message, durationMs: Date.now() - startedAt });
    }
  }

  let geoSection = '';
  if (geoDefs.length > 0) {
    needsLeaflet = true;
    const UNION_KINDS = new Set(['geo-polygon', 'geo-feature', 'geo-featurecollection']);
    const CONTAINED_KINDS = new Set(['geo-featurecollection-props', 'geo-feature-array']);
    const unionField = geoDefs.find(d => UNION_KINDS.has(d.kind));

    const geoFields = geoDefs.map(({ name, def, kind, llmClassification }) => {
      const opts = {};
      if (llmClassification) opts.llmClassification = llmClassification;
      if (unionField && CONTAINED_KINDS.has(kind) && name !== unionField.name) {
        opts.containerVarName = fieldRenderer.jsVarName(unionField.name);
      }
      return describeGeoField(name, def, kind, opts);
    });
    const geoResult = renderGeoFields(geoFields);
    geoSection = geoResult.html;
    initJsParts.push(geoResult.initJs);
    validateJsParts.push(geoResult.validateJs);
    Object.assign(collectExprs, geoResult.collectExprs);
  }

  if (nestedArrayFields.length > 0) {
    initJsParts.push(buildNestedArrayEngineScript(nestedArrayFields));
  }

  const bodyHtml = geoSection + nonGeoSections.join('\n');

  const html = renderPage({
    title: title || 'Analysis',
    description,
    needsLeaflet,
    bodyHtml,
    initJs: initJsParts.join('\n'),
    validateJs: validateJsParts.join('\n'),
    collectExprs,
    processId: id,
  });

  return { html, log };
}

module.exports = { generateHtml };
