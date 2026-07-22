// Rendering dei campi geografici (Polygon/Feature/FeatureCollection e varianti) come mappa
// Leaflet + leaflet-draw condivisa. Copre due ruoli distinti, entrambi "multi-draw":
// - union (study_area, bounding_box): più poligoni disegnati, fusi con turf.union in
//   un'unica area; sulla mappa si vede solo il contorno tratteggiato del risultato.
// - contained (measures, canopy_input): poligoni multipli con una proprietà per feature,
//   validati con turf.booleanContains contro l'area union che li precede nello stesso form.
// Più campi geografici nello stesso processo condividono una mappa sola, alternata tramite
// una phase-bar (vedi Air Filtration: study_area -> measures).
const { escapeHtml } = require('./template');
const { jsVarName, humanize } = require('./fieldRenderer');

const MEASURE_COLORS = ['#805ad5', '#e53e3e', '#d69e2e', '#38a169', '#3182ce', '#dd6b20', '#d53f8c', '#718096'];

// Extracts { propKey, propType } for FeatureCollection-with-props / Feature-array cases
function extractRequiredProp(schema, kind) {
  let propsSchema;
  if (kind === 'geo-featurecollection-props') {
    propsSchema = schema.properties.features.items.properties.properties;
  } else if (kind === 'geo-feature-array') {
    propsSchema = schema.items.properties.properties;
  }
  const propKey = propsSchema.required[0];
  const propType = propsSchema.properties[propKey].type;
  return { propKey, propType };
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
function describeGeoField(name, def, kind, opts = {}) {
  const isUnionCapable = kind === 'geo-polygon' || kind === 'geo-feature' || kind === 'geo-featurecollection';
  const isContained = kind === 'geo-featurecollection-props' || kind === 'geo-feature-array';
  const base = {
    name,
    varName: jsVarName(name),
    title: def.title,
    description: def.description,
    kind,
    // union: multi-draw, merged into one polygon via turf.union
    union: isUnionCapable,
    // multi: renders as a repeated-draw field with a feature list
    multi: isUnionCapable || isContained,
    // containerVarName: set on a "contained" field to reference the union field acting as its boundary
    containerVarName: isContained ? opts.containerVarName || null : null,
  };
  if (isContained) {
    base.prop = extractRequiredProp(def.schema, kind);
  }
  return base;
}

function renderGeoFields(fields) {
  const needsLeaflet = true;
  const isSinglePhase = fields.length === 1;

  const phaseButtons = fields.map((f, i) => `      <button type="button" class="phase-btn${i === 0 ? ' active' : ''}" id="btn_${f.varName}" onclick="setPhase_geo('${f.varName}')"${i === 0 ? '' : ' disabled'}>
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

  // Done buttons for union fields float as an overlay on top of the map itself, so they
  // stay visible right where the user is drawing instead of below the map.
  const doneOverlaysHtml = fields.map((f, i) => {
    const isLastPhase = i === fields.length - 1;
    if (!f.union || isLastPhase) return '';
    return `      <button type="button" class="btn-done-overlay" id="btnDone_${f.varName}" onclick="confirmDone_${f.varName}()" style="display:none">Done — continue to ${escapeHtml(fields[i + 1].title)}</button>`;
  }).filter(Boolean).join('\n');

  const errorsHtml = fields.map(f => `    <span class="error-msg" id="err_${f.varName}">Please draw ${f.multi ? `at least one ${escapeHtml(f.title)} polygon` : `the ${escapeHtml(f.title)} polygon`}.</span>`).join('\n')
    + (fields.some(f => f.multi && f.prop) ? '\n' + fields.filter(f => f.multi && f.prop).map(f => `    <span class="error-msg" id="propErr_${f.varName}">Please assign a value to each ${escapeHtml(f.title)} feature.</span>`).join('\n') : '')
    + (fields.some(f => f.containerVarName) ? '\n' + fields.filter(f => f.containerVarName).map(f => `    <span class="error-msg" id="containErr_${f.varName}">Each ${escapeHtml(f.title)} polygon must be drawn inside the ${escapeHtml(fields.find(x => x.varName === f.containerVarName).title)} boundary.</span>`).join('\n') : '');

  const html = `  <div class="section">
    <div class="section-title">Map</div>
${phaseBarHtml}    <div class="map-hint" id="mapHint">Draw the ${escapeHtml(fields[0].title)} polygon${fields[0].multi ? '(s)' : ''}.</div>
    <div class="map-wrap">
      <div class="map-container phase-active" id="map"></div>
${doneOverlaysHtml}
    </div>
${errorsHtml}
  </div>
${listSectionsHtml ? listSectionsHtml + '\n' : ''}`;

  // ── JS ──────────────────────────────────────────────────────────────────
  const fieldsJsList = fields.map(f => `'${f.varName}'`).join(', ');

  const stateDecls = fields.map(f => f.union
    ? `  const layer_${f.varName} = new L.FeatureGroup().addTo(map);\n  const mergedLayer_${f.varName} = new L.FeatureGroup().addTo(map);\n  let items_${f.varName} = [];\n  let counter_${f.varName} = 0;\n  let merged_${f.varName} = null;`
    : f.multi
      ? `  const layer_${f.varName} = new L.FeatureGroup().addTo(map);\n  let items_${f.varName} = [];\n  let counter_${f.varName} = 0;`
      : `  const layer_${f.varName} = new L.FeatureGroup().addTo(map);\n  let geojson_${f.varName} = null;`
  ).join('\n');

  const labelLayerDecl = fields.some(f => f.multi) ? `  const labelLayer = new L.FeatureGroup().addTo(map);` : '';

  const drawControlDecls = fields.map(f => `  const draw_${f.varName} = new L.Control.Draw({
    edit: { featureGroup: layer_${f.varName} },
    draw: { polygon: true, rectangle: true, circle: true, polyline: false, marker: false, circlemarker: false }
  });`).join('\n');

  const phaseSwitchCases = fields.map(f => `    if (phaseKey === '${f.varName}') {
      draw_${f.varName}.addTo(map);
      document.getElementById('mapHint').textContent = 'Draw the ${escapeHtml(f.title)} polygon${f.multi ? '(s)' : ''}.';
      ${isSinglePhase ? '' : `document.getElementById('btn_${f.varName}').classList.add('active');`}
    }`).join(' else ');

  const phaseSwitchOthers = fields.map(f => `    if (phaseKey !== '${f.varName}') {
      try { map.removeControl(draw_${f.varName}); } catch(e) {}
      ${isSinglePhase ? '' : `document.getElementById('btn_${f.varName}').classList.remove('active');`}
    }`).join('\n');

  const setPhaseFn = isSinglePhase ? '' : `
  function setPhase_geo(phaseKey) {
    currentPhase = phaseKey;
${phaseSwitchOthers}
${phaseSwitchCases}
    fields.forEach(f => {
      const section = document.getElementById('section_' + f);
      if (section) section.style.display = (f === phaseKey) ? '' : 'none';
      const doneBtn = document.getElementById('btnDone_' + f);
      if (doneBtn) doneBtn.style.display = (f === phaseKey && doneBtn.dataset.hasItems === '1') ? '' : 'none';
    });
  }`;

  // Recompute the merged (turf.union) polygon for a union field from its drawn items,
  // and redraw it as a highlighted outline so the resulting area is visible live.
  const mergeFns = fields.filter(f => f.union).map(f => `
  function recomputeMerged_${f.varName}() {
    mergedLayer_${f.varName}.clearLayers();
    if (items_${f.varName}.length === 0) { merged_${f.varName} = null; return; }
    let acc = turf.polygon(items_${f.varName}[0].geometry.coordinates);
    for (let i = 1; i < items_${f.varName}.length; i++) {
      try {
        acc = turf.union(acc, turf.polygon(items_${f.varName}[i].geometry.coordinates));
      } catch (err) { /* non-overlapping or invalid geometry: keep accumulated result */ }
    }
    merged_${f.varName} = acc.geometry;
    L.geoJSON(merged_${f.varName}, {
      style: { color: '#1a1a2e', weight: 3, dashArray: '6 4', fillColor: '#3a7bd5', fillOpacity: 0.12, interactive: false }
    }).addTo(mergedLayer_${f.varName});
  }`).join('\n');

  const createdHandlerCases = fields.map((f, i) => {
    if (f.union) {
      const isLastPhase = i === fields.length - 1;
      return `    if (currentPhase === '${f.varName}') {
      counter_${f.varName}++;
      const idx = counter_${f.varName};
      if (e.layer.setStyle) e.layer.setStyle({ stroke: false, fill: false });
      layer_${f.varName}.addLayer(e.layer);
      items_${f.varName}.push({ idx, layer: e.layer, geometry: layerToPolygonGeometry(e.layer) });
      recomputeMerged_${f.varName}();
      ${!isLastPhase ? `const doneBtn_${f.varName} = document.getElementById('btnDone_${f.varName}');
      if (doneBtn_${f.varName}) { doneBtn_${f.varName}.style.display = ''; doneBtn_${f.varName}.dataset.hasItems = '1'; }` : ''}
    }`;
    }
    if (f.multi) {
      return `    if (currentPhase === '${f.varName}') {
      const drawnGeom_${f.varName} = layerToPolygonGeometry(e.layer);
      ${f.containerVarName ? `if (merged_${f.containerVarName} && !turf.booleanContains(turf.feature(merged_${f.containerVarName}), turf.feature(drawnGeom_${f.varName}))) {
        layer_${f.varName}.removeLayer(e.layer);
        document.getElementById('containErr_${f.varName}').style.display = 'block';
        return;
      }
      document.getElementById('containErr_${f.varName}').style.display = 'none';` : ''}
      counter_${f.varName}++;
      const idx = counter_${f.varName};
      if (e.layer.setStyle) e.layer.setStyle({ color: MEASURE_COLORS[(idx - 1) % MEASURE_COLORS.length], fillOpacity: 0.25 });
      layer_${f.varName}.addLayer(e.layer);
      const color = MEASURE_COLORS[(idx - 1) % MEASURE_COLORS.length];
      const center = e.layer.getBounds().getCenter();
      const icon = L.divIcon({
        html: '<div style="background:' + color + ';color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.3)">' + idx + '</div>',
        className: '', iconSize: [22, 22], iconAnchor: [11, 11]
      });
      const marker = L.marker(center, { icon, interactive: false }).addTo(labelLayer);
      items_${f.varName}.push({ idx, layer: e.layer, marker, color, geometry: drawnGeom_${f.varName}, propValue: null });
      renderList_${f.varName}();
    }`;
    }
    return `    if (currentPhase === '${f.varName}') {
      layer_${f.varName}.clearLayers();
      layer_${f.varName}.addLayer(e.layer);
      geojson_${f.varName} = layerToPolygonGeometry(e.layer);
      ${isSinglePhase ? '' : `
      document.getElementById('btn_${f.varName}').classList.remove('active');
      document.getElementById('btn_${f.varName}').classList.add('done');
      document.getElementById('icon_${f.varName}').textContent = '✓';
      ${advanceToNext(fields, f)}`}
    }`;
  }).join(' else ');

  function advanceToNext(allFields, current) {
    const idx = allFields.indexOf(current);
    const next = allFields[idx + 1];
    if (!next) return '';
    return `document.getElementById('btn_${next.varName}').disabled = false;\n      setPhase_geo('${next.varName}');`;
  }

  const renderListFns = fields.filter(f => f.multi && !f.union).map(f => `
  function renderList_${f.varName}() {
    const list = document.getElementById('list_${f.varName}');
    list.innerHTML = '';
    items_${f.varName}.forEach(m => {
      const row = document.createElement('div');
      row.className = 'feature-row';
      row.innerHTML = '<div class="feature-swatch" style="background:' + m.color + '"></div>' +
        '<span class="feature-label">${escapeHtml(f.title)} #' + m.idx + '</span>' +
        ${f.prop ? `'<input type="number" class="feature-prop-input" id="prop_${f.varName}_' + m.idx + '" placeholder="${escapeHtml(f.prop.propKey)}" value="' + (m.propValue ?? '') + '">' +` : ''}
        '<button type="button" class="btn-remove-feature" onclick="removeItem_${f.varName}(' + m.idx + ')">×</button>';
      list.appendChild(row);
      ${f.prop ? `row.querySelector('#prop_${f.varName}_' + m.idx).addEventListener('input', function() {
        const entry = items_${f.varName}.find(x => x.idx === m.idx);
        if (entry) entry.propValue = ${f.prop.propType === 'integer' ? 'parseInt(this.value, 10)' : 'parseFloat(this.value)'};
      });` : ''}
    });
    document.getElementById('section_${f.varName}').style.display = items_${f.varName}.length ? '' : (currentPhase === '${f.varName}' ? '' : 'none');
  }
  function removeItem_${f.varName}(idx) {
    const m = items_${f.varName}.find(x => x.idx === idx);
    if (!m) return;
    layer_${f.varName}.removeLayer(m.layer);
    labelLayer.removeLayer(m.marker);
    items_${f.varName} = items_${f.varName}.filter(x => x.idx !== idx);
    renderList_${f.varName}();
  }`).join('\n');

  const confirmDoneFns = fields.map((f, idx) => {
    const isLastPhase = idx === fields.length - 1;
    if (!f.union || isLastPhase) return '';
    const next = fields[idx + 1];
    return `
  function confirmDone_${f.varName}() {
    if (items_${f.varName}.length === 0) return;
    document.getElementById('btn_${f.varName}').classList.remove('active');
    document.getElementById('btn_${f.varName}').classList.add('done');
    document.getElementById('icon_${f.varName}').textContent = '✓';
    document.getElementById('btn_${next.varName}').disabled = false;
    setPhase_geo('${next.varName}');
  }`;
  }).join('\n');

  const deletedHandlerCases = fields.map((f, i) => {
    if (f.union) {
      return `    if (currentPhase === '${f.varName}') {
      const deletedIdx = new Set();
      e.layers.eachLayer(l => {
        const m = items_${f.varName}.find(m => m.layer === l);
        if (m) deletedIdx.add(m.idx);
      });
      items_${f.varName} = items_${f.varName}.filter(m => !deletedIdx.has(m.idx));
      recomputeMerged_${f.varName}();
      if (items_${f.varName}.length === 0) {
        const doneBtn_${f.varName} = document.getElementById('btnDone_${f.varName}');
        if (doneBtn_${f.varName}) { doneBtn_${f.varName}.style.display = 'none'; doneBtn_${f.varName}.dataset.hasItems = ''; }
        ${isSinglePhase ? '' : `document.getElementById('btn_${f.varName}').classList.remove('done');
        document.getElementById('icon_${f.varName}').textContent = '${'①②③④⑤⑥'[i] || (i + 1)}';`}
      }
    }`;
    }
    if (f.multi) {
      return `    if (currentPhase === '${f.varName}') {
      const deletedIdx = new Set();
      e.layers.eachLayer(l => {
        const m = items_${f.varName}.find(m => m.layer === l);
        if (m) { deletedIdx.add(m.idx); labelLayer.removeLayer(m.marker); }
      });
      items_${f.varName} = items_${f.varName}.filter(m => !deletedIdx.has(m.idx));
      renderList_${f.varName}();
    }`;
    }
    return `    if (currentPhase === '${f.varName}') {
      geojson_${f.varName} = null;
      ${isSinglePhase ? '' : `document.getElementById('btn_${f.varName}').classList.remove('done');
      document.getElementById('icon_${f.varName}').textContent = '${'①②③④⑤⑥'[i] || (i + 1)}';`}
    }`;
  }).join(' else ');

  const initJs = `
  // Default center; overridden below by ?lat=&lng=&zoom= query params (if the HTML is
  // loaded via <iframe src="...">) or by a postMessage({ type: 'set-center', lat, lng, zoom })
  // sent from the parent window (if loaded via <iframe srcdoc="...">).
  const DEFAULT_CENTER = [50.88, 4.70];
  const DEFAULT_ZOOM = 13;

  function readCenterFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));
    const zoom = parseFloat(params.get('zoom'));
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat, lng, zoom: isNaN(zoom) ? DEFAULT_ZOOM : zoom };
  }

  const initialCenter = readCenterFromQuery();
  const map = L.map('map').setView(
    initialCenter ? [initialCenter.lat, initialCenter.lng] : DEFAULT_CENTER,
    initialCenter ? initialCenter.zoom : DEFAULT_ZOOM
  );
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  // Let the parent window (re)center the map at any time, e.g. after the user picks a city:
  // iframe.contentWindow.postMessage({ type: 'set-center', lat, lng, zoom }, '*');
  window.addEventListener('message', function(ev) {
    const msg = ev.data;
    if (!msg || msg.type !== 'set-center') return;
    const lat = parseFloat(msg.lat);
    const lng = parseFloat(msg.lng);
    if (isNaN(lat) || isNaN(lng)) return;
    map.setView([lat, lng], isNaN(parseFloat(msg.zoom)) ? map.getZoom() : parseFloat(msg.zoom));
  });

  // Tell the parent the map is ready to receive a set-center message.
  window.parent.postMessage({ type: 'analysis-ready' }, '*');

  // Circles are drawn/edited as center+radius in Leaflet; convert to a GeoJSON Polygon
  // approximation so downstream turf.union / turf.booleanContains and the OGC payload
  // (which expects Polygon geometries) work uniformly for polygon, rectangle and circle.
  function layerToPolygonGeometry(layer) {
    if (layer instanceof L.Circle) {
      const center = layer.getLatLng();
      return turf.circle([center.lng, center.lat], layer.getRadius() / 1000, { units: 'kilometers', steps: 64 }).geometry;
    }
    return layer.toGeoJSON().geometry;
  }

  const MEASURE_COLORS = ${JSON.stringify(MEASURE_COLORS)};
  const fields = [${fieldsJsList}];
  let currentPhase = '${fields[0].varName}';

${stateDecls}
${labelLayerDecl}
${drawControlDecls}
${setPhaseFn}
${mergeFns}

  draw_${fields[0].varName}.addTo(map);

  map.on(L.Draw.Event.CREATED, function(e) {
${createdHandlerCases}
  });

  map.on(L.Draw.Event.DELETED, function(e) {
${deletedHandlerCases}
  });
${renderListFns}
${confirmDoneFns}`;

  const validateJs = fields.map(f => {
    if (f.union) {
      return `
    const err_${f.varName} = document.getElementById('err_${f.varName}');
    if (!merged_${f.varName}) { err_${f.varName}.style.display = 'block'; valid = false; }
    else err_${f.varName}.style.display = 'none';`;
    }
    if (f.multi) {
      const propCheck = f.prop ? `
    const propMissing_${f.varName} = items_${f.varName}.some(m => m.propValue == null || isNaN(m.propValue));
    const propErrEl_${f.varName} = document.getElementById('propErr_${f.varName}');
    if (propMissing_${f.varName}) { propErrEl_${f.varName}.style.display = 'block'; valid = false; }
    else propErrEl_${f.varName}.style.display = 'none';` : '';
      return `
    const err_${f.varName} = document.getElementById('err_${f.varName}');
    if (items_${f.varName}.length === 0) { err_${f.varName}.style.display = 'block'; valid = false; }
    else err_${f.varName}.style.display = 'none';${propCheck}`;
    }
    return `
    const err_${f.varName} = document.getElementById('err_${f.varName}');
    if (!geojson_${f.varName}) { err_${f.varName}.style.display = 'block'; valid = false; }
    else err_${f.varName}.style.display = 'none';`;
  }).join('\n');

  const collectExprs = {};
  fields.forEach(f => {
    if (f.union) {
      if (f.kind === 'geo-polygon') {
        collectExprs[f.name] = `merged_${f.varName}`;
      } else if (f.kind === 'geo-feature') {
        collectExprs[f.name] = `{ type: 'Feature', geometry: merged_${f.varName}, properties: {} }`;
      } else if (f.kind === 'geo-featurecollection') {
        collectExprs[f.name] = `{ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: merged_${f.varName}, properties: {} }] }`;
      }
    } else if (f.kind === 'geo-polygon') {
      collectExprs[f.name] = `geojson_${f.varName}`;
    } else if (f.kind === 'geo-feature') {
      collectExprs[f.name] = `{ type: 'Feature', geometry: geojson_${f.varName}, properties: {} }`;
    } else if (f.kind === 'geo-featurecollection') {
      collectExprs[f.name] = `{ type: 'FeatureCollection', features: items_${f.varName}.map(m => ({ type: 'Feature', geometry: m.geometry, properties: {} })) }`;
    } else if (f.kind === 'geo-featurecollection-props') {
      collectExprs[f.name] = `{ type: 'FeatureCollection', features: items_${f.varName}.map(m => ({ type: 'Feature', geometry: m.geometry, properties: { ${f.prop.propKey}: m.propValue } })) }`;
    } else if (f.kind === 'geo-feature-array') {
      collectExprs[f.name] = `items_${f.varName}.map(m => ({ type: 'Feature', geometry: m.geometry, properties: { ${f.prop.propKey}: m.propValue } }))`;
    }
  });

  return { html, needsLeaflet, initJs, validateJs, collectExprs };
}

module.exports = { describeGeoField, renderGeoFields };
