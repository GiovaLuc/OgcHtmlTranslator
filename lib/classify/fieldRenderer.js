// Classifica la forma dello schema JSON di un campo (mai il suo nome — vedi
// data/rules.txt) in una stringa "kind", e instrada i kind non-geo al renderer
// corrispondente in lib/render/renderers/*.
// Pipeline: chiamato per primo da lib/generateHtml.js per ogni campo; lancia un errore per ciò che non riconosce, il che instrada il campo a lib/llm.
const { renderConst, renderEnumSelect, renderEnumRadio } = require('../render/renderers/enum');
const { renderString, renderNumber, renderBoolean } = require('../render/renderers/scalar');
const { renderObjectNumbers, renderObjectSum } = require('../render/renderers/object');
const { renderArray } = require('../render/renderers/array');
const { renderOneOf } = require('../render/renderers/oneOf');
const { renderTextareaRaw } = require('../render/renderers/fallbackTextarea');
const { jsVarName, humanize } = require('../render/renderers/section');

// Every standard GeoJSON geometry type — Point/LineString/Polygon/MultiPoint/
// MultiLineString/MultiPolygon/GeometryCollection. Which Leaflet draw tool(s) a
// field offers depends on which one its schema declares (see geoRenderer.js's
// resolveDrawTools) — this is the full vocabulary extractGeometryType searches for.
const GEOJSON_GEOMETRY_TYPES = new Set([
  'Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection',
]);

// Subset classifyField treats as a CERTAIN match for its own "geo-polygon" kind —
// deliberately excludes GeometryCollection, which declares no single geometry shape
// by definition (it can hold any mix of points/lines/polygons). Forcing it into
// "geo-polygon" would resolve to the permissive polygon/rectangle/circle draw tools
// without ever reading the field's description for what it should actually contain
// — routing it to 'geo-unknown' instead lets the LLM geo-classification path
// (ollamaGeoPrompt.js) read the description and choose real drawTools dynamically.
const CERTAIN_GEOMETRY_TYPES = new Set(['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon']);

// Note: a schema.allOf wrapping this format marker never reaches here — classifyField
// routes any schema.allOf to the 'oneOf' kind before this check runs. No real schema
// observed uses that pattern; revisit if one does.
function hasExplicitGeoJsonFormat(schema) {
  return !!schema && schema.format === 'geojson-geometry';
}

function isGeoConst(schema, matcher) {
  if (!(schema && schema.type === 'object' && schema.properties && schema.properties.type)) return false;
  const constValue = schema.properties.type.const;
  return typeof matcher === 'function' ? matcher(constValue) : constValue === matcher;
}

function isAnyGeometryConst(schema) {
  return isGeoConst(schema, value => CERTAIN_GEOMETRY_TYPES.has(value));
}

// Finds the actual GeoJSON geometry type (Point/LineString/Polygon/...) a geo field's
// schema declares, wherever it's nested — raw at the top level, inside a Feature's
// "geometry", or inside a FeatureCollection's "features[].geometry". Used only to
// pick the matching Leaflet draw tool (marker/polyline/polygon) in geoRenderer.js —
// never to choose a different "kind" (that's still done structurally by type/const
// presence, per data/rules.txt). Returns null when no geometry type is declared
// (e.g. an LLM-classified field with no type.const anywhere, or additionalProperties
// left open) — callers fall back to the permissive polygon/rectangle/circle set.
function extractGeometryType(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.properties && schema.properties.type) {
    const constValue = schema.properties.type.const;
    if (typeof constValue === 'string' && GEOJSON_GEOMETRY_TYPES.has(constValue)) return constValue;
  }
  if (schema.properties && schema.properties.geometry) {
    const nested = extractGeometryType(schema.properties.geometry);
    if (nested) return nested;
  }
  if (schema.properties && schema.properties.features && schema.properties.features.items) {
    const nested = extractGeometryType(schema.properties.features.items);
    if (nested) return nested;
  }
  if (schema.type === 'array' && schema.items) return extractGeometryType(schema.items);
  return null;
}

// Structural heuristic for a GeoJSON-shaped schema that isn't one of the specific
// kinds classifyField already knows how to render as a map field (e.g. Point,
// LineString, MultiPolygon, GeometryCollection, or a differently-shaped Feature/
// FeatureCollection). Looks for the GeoJSON vocabulary itself — "type"/"geometry"/
// "coordinates"/"features" — never the field's own name (see data/rules.txt).
function looksGeoJsonShaped(schema) {
  if (!schema) return false;
  const objectShape = schema.type === 'object' && schema.properties && (
    'coordinates' in schema.properties ||
    'geometry' in schema.properties ||
    'features' in schema.properties ||
    (schema.properties.type && typeof schema.properties.type.const === 'string')
  );
  if (objectShape) return true;
  if (schema.type === 'array' && schema.items) return looksGeoJsonShaped(schema.items);
  return false;
}

function classifyField(name, def) {
  const schema = def.schema;
  if (!schema) throw new Error(`Unsupported field schema for "${name}": missing schema`);

  if (schema.oneOf || schema.anyOf || schema.allOf) {
    return 'oneOf';
  }
  if (schema.type === 'string' && Array.isArray(schema.enum)) {
    if (schema.enum.length === 1) return 'const';
    return schema.enum.length <= 4 ? 'enum-radio' : 'enum-select';
  }
  if (schema.type === 'string') {
    return 'string';
  }
  if (schema.type === 'boolean') {
    return 'boolean';
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return schema.type;
  }
  // bbox: [minX, minY, maxX, maxY] (2D, 4 numbers) or [minX, minY, minZ, maxX, maxY, maxZ]
  // (3D, 6 numbers) — either way a rectangle drawn on the map; the 3D variant adds a
  // minZ/maxZ pair of plain number inputs alongside it (see geoRenderer.js).
  if (schema.type === 'array' && schema.items && schema.items.type === 'number' &&
    schema.minItems === schema.maxItems && (schema.minItems === 4 || schema.minItems === 6)) {
    return 'geo-bbox';
  }
  // Explicit format marker takes priority over structural guessing: a schema whose
  // top level IS the geometry (no Feature/FeatureCollection envelope), of any
  // GeoJSON geometry type, not just Polygon.
  if (hasExplicitGeoJsonFormat(schema) && schema.type === 'object') return 'geo-polygon';
  if (isAnyGeometryConst(schema)) return 'geo-polygon';
  if (isGeoConst(schema, 'Feature')) return 'geo-feature';
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
  if (schema.type === 'array' && schema.items &&
    (schema.items.type === 'string' || schema.items.type === 'number' || schema.items.type === 'integer')) {
    return 'array';
  }
  if (schema.type === 'object' && schema.properties) {
    const props = Object.values(schema.properties);
    const allPercentages = props.length > 0 && props.every(p =>
      p.type === 'number' && p.minimum === 0 && p.maximum === 100);
    if (allPercentages) return 'object-sum';
    if (props.every(p => p.type === 'number' || p.type === 'integer')) return 'object-numbers';
  }
  // Geometry-shaped but not one of the specific kinds above (Point, LineString,
  // MultiPolygon, GeometryCollection, an unusually-shaped Feature/FeatureCollection,
  // ...): hand it to the LLM geo-classification path (lib/ollamaGeoPrompt.js) instead
  // of the raw-JSON fallback, so it still lands on the shared map, not a textarea.
  if (looksGeoJsonShaped(schema)) return 'geo-unknown';
  throw new Error(`Unsupported field schema for "${name}": ${JSON.stringify(schema)}`);
}

// Renders any non-geo field kind. Geo kinds are handled separately in
// lib/generateHtml.js via geoRenderer.js.
function renderField(name, def) {
  const kind = classifyField(name, def);
  switch (kind) {
    case 'const': return renderConst(name, def);
    case 'enum-select': return renderEnumSelect(name, def);
    case 'enum-radio': return renderEnumRadio(name, def);
    case 'string': return renderString(name, def);
    case 'number': return renderNumber(name, def, { integer: false });
    case 'integer': return renderNumber(name, def, { integer: true });
    case 'boolean': return renderBoolean(name, def);
    case 'array': return renderArray(name, def);
    case 'oneOf': return renderOneOf(name, def, renderField);
    case 'object-sum': return renderObjectSum(name, def);
    case 'object-numbers': return renderObjectNumbers(name, def);
    default:
      throw new Error(`Unhandled field kind "${kind}" for field "${name}"`);
  }
}

module.exports = {
  classifyField,
  renderField,
  renderTextareaRaw,
  extractGeometryType,
  jsVarName,
  humanize,
};
