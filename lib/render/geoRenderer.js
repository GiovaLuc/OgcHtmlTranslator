// Genera il markup statico dei campi geografici come mappa Leaflet condivisa, con
// ruoli union (poligoni fusi) e contained (poligoni con proprietà, contenuti nell'area union).
// Pipeline: chiamato da generateHtml.js per i kind geo (statici o classificati via LLM); lo stato/interazione vive in geoFieldEngine.js, iniettato a parte.
const { escapeHtml } = require('./template');
const { jsVarName, humanize, extractGeometryType } = require('../classify/fieldRenderer');
const { buildGeoFieldEngineScript } = require('./geoFieldEngine');
const { isRepeatable } = require('../llm/geoSchemaHeuristics');

// Extracts [{ propKey, propType }] for FeatureCollection-with-props / Feature-array
// cases — EVERY property in the per-item schema's own "required" list, not just the
// first. The static classifier only ever sees schema-declared properties (no LLM
// description-inference here, see opts.llmClassification below for that path).
function extractRequiredProps(schema, kind) {
  let propsSchema;
  if (kind === 'geo-featurecollection-props') {
    propsSchema = schema.properties.features.items.properties.properties;
  } else if (kind === 'geo-feature-array') {
    propsSchema = schema.items.properties.properties;
  }
  return propsSchema.required.map(propKey => ({
    propKey, propType: propsSchema.properties[propKey].type,
  }));
}

// Maps an LLM geo classification ({ role, wrapper, requiredProp }, see
// lib/ollamaGeoPrompt.js + lib/sanitizeLlmGeoField.js) onto one of the synthetic
// "kind" strings the rest of this pipeline (below, and geoFieldEngine.js's
// collectValue) already knows how to draw and wrap — so a field the static
// classifier couldn't name still rides the exact same map/engine code as a
// statically-recognized one, no separate code path needed downstream.
function kindFromLlmGeoClassification({ role, wrapper, requiredProp }) {
  if (role === 'contained') {
    return wrapper === 'feature-array' ? 'geo-feature-array' : 'geo-featurecollection-props';
  }
  if (wrapper === 'feature') return 'geo-feature';
  if (wrapper === 'featurecollection') return 'geo-featurecollection';
  // "raw-geometry" (single, top-level geometry with no Feature/FeatureCollection
  // envelope): geo-polygon's collectValue path returns s.geojson completely
  // unwrapped, which is exactly this shape regardless of the actual geometry type.
  return 'geo-polygon';
}

/**
 * Builds a phase descriptor for a geo field.
 * - "union" fields (geo-polygon / geo-feature / plain geo-featurecollection) accept multiple
 *   drawn polygons that get merged into a single polygon/multipolygon via turf.union, then
 *   wrapped according to the field's GeoJSON kind. A union field followed by a "contained"
 *   field (measures/canopy-like) acts as the containment boundary for it.
 * - "contained" fields (geo-featurecollection-props / geo-feature-array) are multi-draw fields
 *   whose polygons must fall inside the preceding union field's boundary, each carrying a
 *   required property value.
 */
// `opts.llmClassification` — when the field came from the LLM geo-classification path
// (kind 'geo-unknown', see lib/ollamaRenderer.js's renderGeoFieldWithOllama) — carries
// the already-validated { role, wrapper, requiredProp } instead of a schema shape the
// static kind name could be re-derived from; `kind` itself is normalized to one of the
// known synthetic kinds via kindFromLlmGeoClassification before this runs.
// Point/LineString have no "merged area" concept — turf.union/turf.polygon() both
// assume Polygon-shaped coordinates, so union is never valid for them regardless of
// maxOccurs. Everything else (Polygon/MultiPolygon, or no declared geometry type at
// all — an LLM-classified field, or the permissive fallback) keeps the historical
// union-capable behavior.
const NON_AREAL_GEOMETRY_TYPES = new Set(['Point', 'LineString', 'MultiPoint', 'MultiLineString']);

// geometryType -> the single leaflet-draw tool it implies, when extractGeometryType
// found a certain match. Areal types (Polygon/MultiPolygon/GeometryCollection) and
// "no declared type at all" have no single certain tool — they fall through to
// drawTools from the LLM classification (when present) or the permissive default.
const DRAW_TOOLS_BY_GEOMETRY_TYPE = { Point: ['marker'], LineString: ['polyline'] };
const DEFAULT_DRAW_TOOLS = ['polygon', 'rectangle', 'circle'];

// Resolves which draw tool(s) a field's map control should offer. extractGeometryType
// is the source of truth whenever it finds a certain match (Point/LineString) — no
// LLM call needed, zero added latency for the common case. Only when the schema
// doesn't declare a single certain geometry type (null, or something ambiguous like
// GeometryCollection) does the LLM's own drawTools choice (opts.llmClassification,
// already validated against a closed tool enum in sanitizeLlmGeoField.js) take over;
// absent that, the permissive polygon/rectangle/circle default applies.
function resolveDrawTools(geometryType, opts) {
  if (geometryType && DRAW_TOOLS_BY_GEOMETRY_TYPE[geometryType]) {
    return DRAW_TOOLS_BY_GEOMETRY_TYPE[geometryType];
  }
  if (opts.llmClassification && Array.isArray(opts.llmClassification.drawTools) && opts.llmClassification.drawTools.length > 0) {
    return opts.llmClassification.drawTools;
  }
  return DEFAULT_DRAW_TOOLS;
}

function describeGeoField(name, def, kind, opts = {}) {
  const geometryType = extractGeometryType(def.schema);
  const isNonAreal = geometryType && NON_AREAL_GEOMETRY_TYPES.has(geometryType);

  // geo-polygon is a bare geometry with no Feature/FeatureCollection envelope — it's
  // only "union" (multi-draw, merged via turf.union) when maxOccurs actually allows
  // more than one shape AND the geometry type is areal. With maxOccurs:1, or with a
  // non-areal type, it's a single shape, full stop: treating it as union anyway broke
  // non-Polygon geometries (Point/LineString), because recomputeMerged's
  // turf.polygon(...) call assumes Polygon-shaped coordinates regardless of the
  // field's real geometry type — a bug that only shows up once there's more than
  // zero items to merge, i.e. exactly when union is wrongly true.
  // geo-feature/geo-featurecollection stay unconditionally union-capable (unless the
  // wrapped geometry is itself non-areal): their own schema shape already implies a
  // collection, union has always been correct there.
  const isUnionCapable = !isNonAreal && (
    kind === 'geo-feature' || kind === 'geo-featurecollection' ||
    (kind === 'geo-polygon' && isRepeatable(def.maxOccurs))
  );
  const isContained = kind === 'geo-featurecollection-props' || kind === 'geo-feature-array';
  const base = {
    name,
    varName: jsVarName(name),
    title: def.title,
    description: def.description,
    kind,
    // geometryType: never changes `kind` itself, kept only for isUnionCapable above.
    geometryType,
    // drawTools: the resolved list of leaflet-draw tools geoFieldEngine.client.js
    // should offer — certain geometry types decide it outright; anything ambiguous
    // falls back to the LLM's own choice (when this field went through geo-unknown
    // classification) or the permissive polygon/rectangle/circle default.
    drawTools: resolveDrawTools(geometryType, opts),
    // union: multi-draw, merged into one polygon via turf.union
    union: isUnionCapable,
    // multi: renders as a repeated-draw field with a feature list
    multi: isUnionCapable || isContained,
    // containerVarName: set on a "contained" field to reference the union field acting as its boundary
    containerVarName: isContained ? opts.containerVarName || null : null,
    // bbox: exactly one rectangle, restricted to the rectangle draw tool only
    bboxOnly: kind === 'geo-bbox',
    // 3D bbox ([minX,minY,minZ,maxX,maxY,maxZ], 6 numbers): the map still only draws
    // the 2D rectangle — minZ/maxZ are plain number inputs alongside it, composed
    // into the final 6-element array at collect time (see geoFieldEngine.client.js).
    bbox3D: kind === 'geo-bbox' && def.schema.minItems === 6,
  };
  if (isContained) {
    // base.props is always an array, from either source: the static path (every
    // schema-required property) or the LLM path (schema-required + description-
    // inferred, see ollamaGeoPrompt.js/sanitizeLlmGeoField.js). Never just the first.
    base.props = opts.llmClassification
      ? opts.llmClassification.requiredProp.map(p => ({ propKey: p.key, propType: p.type, inferred: p.inferred, reason: p.reason }))
      : extractRequiredProps(def.schema, kind);
  }
  return base;
}

function renderGeoFields(fields) {
  const needsLeaflet = true;
  const isSinglePhase = fields.length === 1;

  const phaseButtons = fields.map((f, i) => `      <button type="button" class="phase-btn${i === 0 ? ' active' : ''}" id="btn_${f.varName}" data-phase-switch="${f.name}"${i === 0 ? '' : ' disabled'}>
        <span id="icon_${f.varName}">${'①②③④⑤⑥'[i] || (i + 1)}</span> ${escapeHtml(f.title)}
      </button>`).join('\n');

  const phaseBarHtml = isSinglePhase ? '' : `    <div class="phase-bar">
${phaseButtons}
    </div>
`;

  const listSectionsHtml = fields.map((f, i) => {
    if (!f.multi || f.union) return '';
    const isInitialPhase = i === 0;
    return `  <div class="section" id="section_${f.varName}" style="display:${isInitialPhase ? '' : 'none'}">
    <div class="section-title">${escapeHtml(f.title)}</div>
    <p class="hint">Assign a value to each drawn polygon.</p>
    <div class="feature-list" id="list_${f.varName}"></div>
  </div>`;
  }).filter(Boolean).join('\n');

  // 3D bbox fields get two plain number inputs for the elevation range, read directly
  // by collectValue (see geoFieldEngine.client.js) alongside the 2D rectangle drawn
  // on the map — not part of the declarative formEngine.js contract, since they feed
  // into the geo field's own composite value, not a standalone payload key.
  const elevationSectionsHtml = fields.filter(f => f.bbox3D).map(f => `  <div class="section">
    <div class="section-title">${escapeHtml(f.title)} — Elevation Range</div>
    <label for="${f.varName}_minZ">Min elevation</label>
    <input type="number" step="any" id="${f.varName}_minZ" required>
    <label for="${f.varName}_maxZ">Max elevation</label>
    <input type="number" step="any" id="${f.varName}_maxZ" required>
  </div>`).join('\n');

  // Done buttons for union fields float as an overlay on top of the map itself, so they
  // stay visible right where the user is drawing instead of below the map.
  const doneOverlaysHtml = fields.map((f, i) => {
    const isLastPhase = i === fields.length - 1;
    if (!f.union || isLastPhase) return '';
    return `      <button type="button" class="btn-done-overlay" id="btnDone_${f.varName}" data-phase-done="${f.name}" style="display:none">Done — continue to ${escapeHtml(fields[i + 1].title)}</button>`;
  }).filter(Boolean).join('\n');

  // Describes the hint/error text in terms of whichever single tool is actually
  // offered; falls back to the generic "shape" when more than one tool is active
  // (e.g. an LLM-resolved ["marker","polyline"] for a mixed GeometryCollection).
  const shapeWord = f => {
    if (f.bboxOnly) return 'rectangle';
    const tools = f.drawTools || [];
    if (tools.length === 1) {
      if (tools[0] === 'marker') return 'point';
      if (tools[0] === 'polyline') return 'line';
    }
    return 'polygon';
  };
  const hasProps = f => f.multi && Array.isArray(f.props) && f.props.length > 0;
  const errorsHtml = fields.map(f => `    <span class="error-msg" id="err_${f.varName}">Please draw ${f.multi ? `at least one ${escapeHtml(f.title)} ${shapeWord(f)}` : `the ${escapeHtml(f.title)} ${shapeWord(f)}`}.</span>`).join('\n')
    + (fields.some(hasProps) ? '\n' + fields.filter(hasProps).map(f => `    <span class="error-msg" id="propErr_${f.varName}">Please assign a value to each ${escapeHtml(f.title)} feature.</span>`).join('\n') : '')
    + (fields.some(f => f.containerVarName) ? '\n' + fields.filter(f => f.containerVarName).map(f => `    <span class="error-msg" id="containErr_${f.varName}">Each ${escapeHtml(f.title)} polygon must be drawn inside the ${escapeHtml(fields.find(x => x.varName === f.containerVarName).title)} boundary.</span>`).join('\n') : '');

  const html = `  <div class="section">
    <div class="section-title">Map</div>
${phaseBarHtml}    <div class="map-hint" id="mapHint">Draw the ${escapeHtml(fields[0].title)} ${shapeWord(fields[0])}${fields[0].multi ? '(s)' : ''}.</div>
    <div class="map-wrap">
      <div class="map-container phase-active" id="map"></div>
${doneOverlaysHtml}
    </div>
${errorsHtml}
  </div>
${listSectionsHtml ? listSectionsHtml + '\n' : ''}${elevationSectionsHtml ? elevationSectionsHtml + '\n' : ''}`;

  // Descriptors passed to the injected engine as data — engine code is fixed.
  const initJs = buildGeoFieldEngineScript(fields.map(f => ({
    name: f.name, varName: f.varName, title: f.title, kind: f.kind,
    union: f.union, multi: f.multi, containerVarName: f.containerVarName, props: f.props,
    bboxOnly: f.bboxOnly, bbox3D: f.bbox3D, drawTools: f.drawTools,
  })));

  const validateJs = `
  if (window.__geoEngine && !window.__geoEngine.validate()) valid = false;`;

  const collectExprs = {};
  fields.forEach(f => {
    collectExprs[f.name] = `window.__geoEngine.collectValue(${JSON.stringify(f.name)})`;
  });

  return { html, needsLeaflet, initJs, validateJs, collectExprs };
}

module.exports = { describeGeoField, renderGeoFields, kindFromLlmGeoClassification };
