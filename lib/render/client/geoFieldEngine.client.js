// Motore runtime per i campi geo (mappa Leaflet condivisa), con tre ruoli: union
// (forme fuse via turf.union), contained (forme con una o più proprietà obbligatorie
// in f.props[], validate contro un campo union precedente), single (esattamente una forma).
// Pipeline: guidato dai descrittori per campo passati come dati all'init (vedi il fondo di questo file); il lato HTML è lib/render/geoRenderer.js.

const MEASURE_COLORS = ['#805ad5', '#e53e3e', '#d69e2e', '#38a169', '#3182ce', '#dd6b20', '#d53f8c', '#718096'];

// Circles are center+radius in Leaflet; approximate as a GeoJSON Polygon so union/
// containment/payload all work uniformly for polygon, rectangle and circle.
function layerToPolygonGeometry(layer) {
  if (layer instanceof L.Circle) {
    const center = layer.getLatLng();
    return turf.circle([center.lng, center.lat], layer.getRadius() / 1000, { units: 'kilometers', steps: 64 }).geometry;
  }
  return layer.toGeoJSON().geometry;
}

class GeoFieldEngine {
  // fields: descriptors from lib/render/geoRenderer.js's describeGeoField, as data.
  constructor(map, fields) {
    this.map = map;
    this.fields = fields;
    this.byName = new Map(fields.map(f => [f.name, f]));
    this.state = new Map();
    this.currentPhase = fields[0].name;
    this.labelLayer = fields.some(f => f.multi) ? new L.FeatureGroup().addTo(map) : null;

    fields.forEach(f => this.state.set(f.name, this._initialState(f)));
    this.drawControls = new Map(fields.map(f => [f.name, this._buildDrawControl(f)]));

    this.drawControls.get(fields[0].name).addTo(map);

    map.on(L.Draw.Event.CREATED, (e) => this._onCreated(e));
    map.on(L.Draw.Event.DELETED, (e) => this._onDeleted(e));
  }

  _initialState(f) {
    const layer = new L.FeatureGroup().addTo(this.map);
    if (f.union) {
      return { layer, mergedLayer: new L.FeatureGroup().addTo(this.map), items: [], counter: 0, merged: null };
    }
    if (f.multi) {
      return { layer, items: [], counter: 0 };
    }
    return { layer, geojson: null };
  }

  // f.drawTools is already fully resolved server-side (geoRenderer.js's
  // resolveDrawTools): certain geometry types (Point/LineString) decide it outright,
  // ambiguous ones fall back to the LLM's own choice or the permissive
  // polygon/rectangle/circle default — this just turns that array into the flag
  // object leaflet-draw expects, one tool enabled per entry, nothing more.
  _buildDrawControl(f) {
    const NONE = { polygon: false, rectangle: false, circle: false, polyline: false, marker: false, circlemarker: false };
    const draw = f.bboxOnly ? { ...NONE, rectangle: true } : { ...NONE };
    if (!f.bboxOnly) {
      (f.drawTools || ['polygon', 'rectangle', 'circle']).forEach(tool => { draw[tool] = true; });
    }
    return new L.Control.Draw({
      edit: { featureGroup: this.state.get(f.name).layer },
      draw,
    });
  }

  // ── Phase switching ──────────────────────────────────────────────────────
  setPhase(fieldName) {
    this.currentPhase = fieldName;
    this.fields.forEach(f => {
      const control = this.drawControls.get(f.name);
      if (f.name !== fieldName) {
        try { this.map.removeControl(control); } catch (e) { /* not currently added */ }
      }
    });
    this.drawControls.get(fieldName).addTo(this.map);

    const hint = document.getElementById('mapHint');
    const phaseField = this.byName.get(fieldName);
    if (hint) hint.textContent = 'Draw the ' + phaseField.title + ' ' + (phaseField.bboxOnly ? 'rectangle' : 'polygon') + (phaseField.multi ? '(s)' : '') + '.';

    this.fields.forEach(f => {
      const btn = document.getElementById('btn_' + f.varName);
      if (btn) btn.classList.toggle('active', f.name === fieldName);
      const section = document.getElementById('section_' + f.varName);
      if (section) section.style.display = (f.name === fieldName) ? '' : 'none';
      const doneBtn = document.getElementById('btnDone_' + f.varName);
      if (doneBtn) doneBtn.style.display = (f.name === fieldName && doneBtn.dataset.hasItems === '1') ? '' : 'none';
    });
  }

  advanceToNextPhase(fromFieldName) {
    const idx = this.fields.findIndex(f => f.name === fromFieldName);
    const next = this.fields[idx + 1];
    if (!next) return;
    const nextBtn = document.getElementById('btn_' + next.varName);
    if (nextBtn) nextBtn.disabled = false;
    this.setPhase(next.name);
  }

  // ── Union: merge + redraw outline ────────────────────────────────────────
  recomputeMerged(fieldName) {
    const s = this.state.get(fieldName);
    s.mergedLayer.clearLayers();
    if (s.items.length === 0) { s.merged = null; return; }
    let acc = turf.polygon(s.items[0].geometry.coordinates);
    for (let i = 1; i < s.items.length; i++) {
      try {
        acc = turf.union(acc, turf.polygon(s.items[i].geometry.coordinates));
      } catch (err) { /* non-overlapping or invalid geometry: keep accumulated result */ }
    }
    s.merged = acc.geometry;
    L.geoJSON(s.merged, {
      style: { color: '#1a1a2e', weight: 3, dashArray: '6 4', fillColor: '#3a7bd5', fillOpacity: 0.12, interactive: false },
    }).addTo(s.mergedLayer);
  }

  confirmDone(fieldName) {
    const s = this.state.get(fieldName);
    if (s.items.length === 0) return;
    const btn = document.getElementById('btn_' + this.byName.get(fieldName).varName);
    if (btn) { btn.classList.remove('active'); btn.classList.add('done'); }
    const icon = document.getElementById('icon_' + this.byName.get(fieldName).varName);
    if (icon) icon.textContent = '✓';
    this.advanceToNextPhase(fieldName);
  }

  // ── Contained/multi: per-shape property list ─────────────────────────────
  // f.props is always an array (0, 1, or more entries) — one <input> per entry,
  // all on the same row, each writing into item.propValues[propKey].
  renderFeatureList(fieldName) {
    const f = this.byName.get(fieldName);
    const s = this.state.get(fieldName);
    const list = document.getElementById('list_' + f.varName);
    if (!list) return;
    const props = f.props || [];
    list.innerHTML = '';
    s.items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'feature-row';
      const inputsHtml = props.map(p => '<input type="number" class="feature-prop-input" id="prop_' + f.varName + '_' + item.idx + '_' + p.propKey + '" placeholder="' + p.propKey + (p.inferred ? ' (inferred)' : '') + '" value="' + (item.propValues[p.propKey] ?? '') + '">').join('');
      row.innerHTML = '<div class="feature-swatch" style="background:' + item.color + '"></div>' +
        '<span class="feature-label">' + f.title + ' #' + item.idx + '</span>' +
        inputsHtml +
        '<button type="button" class="btn-remove-feature" data-remove-feature="' + f.name + '" data-remove-idx="' + item.idx + '">×</button>';
      list.appendChild(row);
      props.forEach(p => {
        row.querySelector('#prop_' + f.varName + '_' + item.idx + '_' + p.propKey).addEventListener('input', (ev) => {
          const entry = s.items.find(x => x.idx === item.idx);
          if (entry) entry.propValues[p.propKey] = p.propType === 'integer' ? parseInt(ev.target.value, 10) : parseFloat(ev.target.value);
        });
      });
    });
    const section = document.getElementById('section_' + f.varName);
    if (section) section.style.display = s.items.length ? '' : (this.currentPhase === fieldName ? '' : 'none');
  }

  removeFeature(fieldName, idx) {
    const s = this.state.get(fieldName);
    const item = s.items.find(x => x.idx === idx);
    if (!item) return;
    s.layer.removeLayer(item.layer);
    if (item.marker) this.labelLayer.removeLayer(item.marker);
    s.items = s.items.filter(x => x.idx !== idx);
    this.renderFeatureList(fieldName);
  }

  // ── Draw / delete events ──────────────────────────────────────────────────
  _onCreated(e) {
    const fieldName = this.currentPhase;
    const f = this.byName.get(fieldName);
    const s = this.state.get(fieldName);

    if (f.union) {
      s.counter++;
      const idx = s.counter;
      if (e.layer.setStyle) e.layer.setStyle({ stroke: false, fill: false });
      s.layer.addLayer(e.layer);
      s.items.push({ idx, layer: e.layer, geometry: layerToPolygonGeometry(e.layer) });
      this.recomputeMerged(fieldName);

      const isLastPhase = this.fields.indexOf(f) === this.fields.length - 1;
      if (!isLastPhase) {
        const doneBtn = document.getElementById('btnDone_' + f.varName);
        if (doneBtn) { doneBtn.style.display = ''; doneBtn.dataset.hasItems = '1'; }
      }
      return;
    }

    if (f.multi) {
      const drawnGeom = layerToPolygonGeometry(e.layer);
      if (f.containerVarName) {
        const containerField = this.fields.find(x => x.varName === f.containerVarName);
        const containerState = containerField && this.state.get(containerField.name);
        const containErrEl = document.getElementById('containErr_' + f.varName);
        if (containerState && containerState.merged &&
          !turf.booleanContains(turf.feature(containerState.merged), turf.feature(drawnGeom))) {
          s.layer.removeLayer(e.layer);
          if (containErrEl) containErrEl.style.display = 'block';
          return;
        }
        if (containErrEl) containErrEl.style.display = 'none';
      }
      s.counter++;
      const idx = s.counter;
      const color = MEASURE_COLORS[(idx - 1) % MEASURE_COLORS.length];
      if (e.layer.setStyle) e.layer.setStyle({ color, fillOpacity: 0.25 });
      s.layer.addLayer(e.layer);
      // L.Marker has no getBounds() (it's a point, not an area) — use its own
      // position directly instead of the center of a bounding box.
      const center = e.layer.getBounds ? e.layer.getBounds().getCenter() : e.layer.getLatLng();
      const icon = L.divIcon({
        html: '<div style="background:' + color + ';color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.3)">' + idx + '</div>',
        className: '', iconSize: [22, 22], iconAnchor: [11, 11],
      });
      const marker = L.marker(center, { icon, interactive: false }).addTo(this.labelLayer);
      s.items.push({ idx, layer: e.layer, marker, color, geometry: drawnGeom, propValues: {} });
      this.renderFeatureList(fieldName);
      return;
    }

    // single: exactly one shape, replaces any previous one
    s.layer.clearLayers();
    s.layer.addLayer(e.layer);
    s.geojson = layerToPolygonGeometry(e.layer);
    if (this.fields.length > 1) {
      const btn = document.getElementById('btn_' + f.varName);
      if (btn) { btn.classList.remove('active'); btn.classList.add('done'); }
      const icon = document.getElementById('icon_' + f.varName);
      if (icon) icon.textContent = '✓';
      this.advanceToNextPhase(fieldName);
    }
  }

  _onDeleted(e) {
    const fieldName = this.currentPhase;
    const f = this.byName.get(fieldName);
    const s = this.state.get(fieldName);

    if (f.union) {
      const deletedIdx = new Set();
      e.layers.eachLayer(l => {
        const m = s.items.find(item => item.layer === l);
        if (m) deletedIdx.add(m.idx);
      });
      s.items = s.items.filter(item => !deletedIdx.has(item.idx));
      this.recomputeMerged(fieldName);
      if (s.items.length === 0) {
        const doneBtn = document.getElementById('btnDone_' + f.varName);
        if (doneBtn) { doneBtn.style.display = 'none'; doneBtn.dataset.hasItems = ''; }
        if (this.fields.length > 1) {
          const btn = document.getElementById('btn_' + f.varName);
          if (btn) btn.classList.remove('done');
        }
      }
      return;
    }

    if (f.multi) {
      const deletedIdx = new Set();
      e.layers.eachLayer(l => {
        const m = s.items.find(item => item.layer === l);
        if (m) { deletedIdx.add(m.idx); this.labelLayer.removeLayer(m.marker); }
      });
      s.items = s.items.filter(item => !deletedIdx.has(item.idx));
      this.renderFeatureList(fieldName);
      return;
    }

    s.geojson = null;
    if (this.fields.length > 1) {
      const btn = document.getElementById('btn_' + f.varName);
      if (btn) btn.classList.remove('done');
    }
  }

  // ── Validation / payload collection ──────────────────────────────────────
  validate() {
    let valid = true;
    this.fields.forEach(f => {
      const s = this.state.get(f.name);
      const errEl = document.getElementById('err_' + f.varName);
      const hasShape = f.union ? !!s.merged : f.multi ? s.items.length > 0 : !!s.geojson;
      if (errEl) errEl.style.display = hasShape ? 'none' : 'block';
      if (!hasShape) valid = false;

      if (f.multi && f.props && f.props.length > 0) {
        const missing = s.items.some(item =>
          f.props.some(p => item.propValues[p.propKey] == null || isNaN(item.propValues[p.propKey])));
        const propErrEl = document.getElementById('propErr_' + f.varName);
        if (propErrEl) propErrEl.style.display = missing ? 'block' : 'none';
        if (missing) valid = false;
      }

      if (f.bbox3D) {
        const minZEl = document.getElementById(f.varName + '_minZ');
        const maxZEl = document.getElementById(f.varName + '_maxZ');
        if (minZEl.value === '' || maxZEl.value === '') valid = false;
      }
    });
    return valid;
  }

  collectValue(fieldName) {
    const f = this.byName.get(fieldName);
    const s = this.state.get(fieldName);

    if (f.union) {
      if (f.kind === 'geo-polygon') return s.merged;
      if (f.kind === 'geo-feature') return { type: 'Feature', geometry: s.merged, properties: {} };
      if (f.kind === 'geo-featurecollection') {
        return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: s.merged, properties: {} }] };
      }
      return null;
    }
    if (f.kind === 'geo-bbox') {
      if (!s.geojson) return null;
      const [minX, minY, maxX, maxY] = turf.bbox(turf.feature(s.geojson));
      if (!f.bbox3D) return [minX, minY, maxX, maxY];
      // 3D variant: the map still only draws the 2D rectangle; minZ/maxZ come from
      // their own plain number inputs (rendered alongside the map, see geoRenderer.js)
      // and get composed into the final 6-element array here.
      const minZ = parseFloat(document.getElementById(f.varName + '_minZ').value);
      const maxZ = parseFloat(document.getElementById(f.varName + '_maxZ').value);
      return [minX, minY, isNaN(minZ) ? null : minZ, maxX, maxY, isNaN(maxZ) ? null : maxZ];
    }
    if (f.kind === 'geo-polygon') return s.geojson;
    if (f.kind === 'geo-feature') return { type: 'Feature', geometry: s.geojson, properties: {} };
    if (f.kind === 'geo-featurecollection') {
      return { type: 'FeatureCollection', features: s.items.map(item => ({ type: 'Feature', geometry: item.geometry, properties: {} })) };
    }
    if (f.kind === 'geo-featurecollection-props') {
      return {
        type: 'FeatureCollection',
        features: s.items.map(item => ({ type: 'Feature', geometry: item.geometry, properties: { ...item.propValues } })),
      };
    }
    if (f.kind === 'geo-feature-array') {
      return s.items.map(item => ({ type: 'Feature', geometry: item.geometry, properties: { ...item.propValues } }));
    }
    return null;
  }
}

// Initial center from ?lat=&lng=&zoom= (also overridable via postMessage set-center).
function readCenterFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  const zoom = parseFloat(params.get('zoom'));
  if (isNaN(lat) || isNaN(lng)) return null;
  return { lat, lng, zoom: isNaN(zoom) ? 13 : zoom };
}

// Builds the map + engine, wires phase-bar/done/remove-feature buttons via data-
// attributes, and exposes window.__geoEngine for the submit handler.
function initGeoFields(fields) {
  const DEFAULT_CENTER = [50.88, 4.70];
  const DEFAULT_ZOOM = 13;

  const initialCenter = readCenterFromQuery();
  const map = L.map('map').setView(
    initialCenter ? [initialCenter.lat, initialCenter.lng] : DEFAULT_CENTER,
    initialCenter ? initialCenter.zoom : DEFAULT_ZOOM
  );
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);

  window.addEventListener('message', function (ev) {
    const msg = ev.data;
    if (!msg || msg.type !== 'set-center') return;
    const lat = parseFloat(msg.lat);
    const lng = parseFloat(msg.lng);
    if (isNaN(lat) || isNaN(lng)) return;
    map.setView([lat, lng], isNaN(parseFloat(msg.zoom)) ? map.getZoom() : parseFloat(msg.zoom));
  });

  const engine = new GeoFieldEngine(map, fields);
  window.__geoEngine = engine;

  document.querySelectorAll('[data-phase-switch]').forEach(btn => {
    btn.addEventListener('click', () => engine.setPhase(btn.dataset.phaseSwitch));
  });
  document.querySelectorAll('[data-phase-done]').forEach(btn => {
    btn.addEventListener('click', () => engine.confirmDone(btn.dataset.phaseDone));
  });
  // Delegated: renderFeatureList() only replaces innerHTML, not the container.
  document.querySelectorAll('.feature-list').forEach(list => {
    list.addEventListener('click', (ev) => {
      const removeBtn = ev.target.closest('[data-remove-feature]');
      if (!removeBtn) return;
      engine.removeFeature(removeBtn.dataset.removeFeature, Number(removeBtn.dataset.removeIdx));
    });
  });

  window.parent.postMessage({ type: 'analysis-ready' }, '*');
}

// NOTE: no initGeoFields(...) call at the bottom of this file — unlike the rest of
// this engine, that call needs this specific page's own field descriptors, which only
// exist in Node at generation time. lib/render/geoFieldEngine.js appends
// `initGeoFields(${JSON.stringify(fields)})` itself, after reading this file's text.
