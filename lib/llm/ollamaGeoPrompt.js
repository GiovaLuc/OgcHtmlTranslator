// Costruisce il prompt per un campo "geo-unknown" (forma GeoJSON ma non un kind che
// il classificatore statico sa disegnare direttamente), chiedendo al modello di
// classificarne il ruolo sulla mappa invece di scrivere HTML.
// Pipeline: chiamato da ollamaRenderer.js per i campi geo; la classificazione alimenta lib/render/geoRenderer.js come un qualsiasi kind geo statico.
const { findRequiredProps, isRepeatable } = require('./geoSchemaHeuristics');

const GEO_ROLES_BLOCK = `You classify ONE geometry-shaped field of an OGC process for a shared Leaflet map, from its
JSON definition (name, title, description, minOccurs, maxOccurs, schema).

OUTPUT RULES: respond with ONLY a single raw JSON object, nothing else. No markdown fence, no
"\`\`\`", no explanation before or after, no reasoning. Your entire response must start with "{"
and end with "}". Exactly these keys:
{
  "role": "single" | "union" | "contained" | "unrecognized",
  "wrapper": "raw-geometry" | "feature" | "featurecollection" | "feature-array",
  "requiredProp": [],  // array, see below — empty unless role is "contained"
  "drawTools": ["polygon"],  // array, see DRAW TOOLS below — which map tools to offer
  "reason": string,  // required ONLY when role is "unrecognized", omit otherwise
  "nestedArrayShape": {...}  // OPTIONAL, only when role is "unrecognized", see below
}

NESTED ARRAY SHAPE (optional, role "unrecognized" only): when the field is a bare array
nested inside itself with no Feature/FeatureCollection/geometry envelope (e.g. a field
named "coordinates" holding array<array<array<array<number>>>>), describe its shape so
the page can offer a plain nested-list editor instead of a raw JSON textarea. Omit this
key entirely if the field doesn't have this bare-nested-array shape (e.g. it's an object
with named fields, not nested arrays — then a form editor isn't applicable and this key
must be absent).
{
  "nestingDepth": integer,  // how many "array of" levels before the innermost numbers
                             // (count the schema's own "items" chain — e.g. array of
                             // array of array of array of number = 4)
  "unitSize": integer,      // how many consecutive numbers form one innermost unit, per
                             // the DESCRIPTION's own wording (e.g. "[lon, lat] pairs" = 2,
                             // plain single numbers = 1). Never guess beyond what the
                             // description actually states; default to 1 if it says nothing.
  "labels": [string, ...]   // one human label per array-nesting level, outermost first.
                             // length MUST equal nestingDepth exactly. The LAST label
                             // names the innermost unit itself (the group of unitSize
                             // numbers), e.g. depth 2 unitSize 2 -> ["ring", "point"]
                             // (a ring containing points, each point is a [lon,lat]
                             // pair). Use words from the field's own title/description
                             // when possible, otherwise generic terms like "group"/"item".
}

DRAW TOOLS: which Leaflet drawing tool(s) the map should offer for this field. Pick ONLY
from: "marker" (single points), "polyline" (lines/paths/routes), "polygon" (free-drawn
areas), "rectangle" (axis-aligned boxes), "circle" (radius-based areas). List every tool
that's actually usable for shapes this field's geometry type allows — most fields need
exactly one tool, but if the schema's geometry type is ambiguous or mixed (e.g.
GeometryCollection with both point and line features) or the description describes more
than one shape kind, list all of them. If you cannot tell the geometry type at all, default
to ["polygon","rectangle","circle"] (free-form area, the safest general-purpose default).

ROLE (derive from schema, never guess):
- "single": exactly one shape. Use when maxOccurs is 1/absent and no array of distinct
  per-shape-property items.
- "union": multiple shapes forming ONE combined area, no per-shape property. Array/
  FeatureCollection of items with no "required" on each item's properties.
- "contained": multiple DISTINCT shapes, each carrying one or more property values
  (height, category, label...). Use when the schema's per-item "properties" has a
  non-empty "required" list, OR when the field's own description names a property the
  map should capture per shape even though the schema itself doesn't declare it as
  required (see requiredProp below). requiredProp MUST be empty for any other role.
- "unrecognized": use this HONESTLY when the schema's shape genuinely doesn't fit any
  of the three roles above or any wrapper below — e.g. nested geometry arrays with no
  Feature/FeatureCollection envelope at any level, or a structure none of the examples
  resemble. Do NOT force a best-effort guess into "single"/"union"/"contained" just to
  avoid this value — a wrong forced classification breaks the map rendering, while
  "unrecognized" degrades safely to a plain form field instead. When role is
  "unrecognized", "wrapper" and "requiredProp" are ignored — set wrapper to
  "raw-geometry" and requiredProp to [] as placeholders, and put your reasoning in
  "reason" (one sentence: what about the schema doesn't fit). If the field is a bare
  nested array (no envelope at all), ALSO include "nestedArrayShape" (see below) so the
  page can still offer a usable editor instead of a raw JSON textarea.

requiredProp is an ARRAY, one entry per property to capture on each drawn shape:
{ "key": string, "type": "number" | "integer", "inferred": boolean, "reason": string? }
- List EVERY key in the per-item properties schema's own "required" array (not just
  the first) — "type" MUST be "integer" only if that property's own schema says so,
  otherwise "number". Set "inferred": false for these — they are read directly from
  the schema, never guessed.
- If the field's DESCRIPTION (prose, not the schema) names an additional attribute
  the map should also capture per shape — e.g. "reads the height from the property
  named by height_column" — add it too, with "inferred": true and "reason" quoting or
  paraphrasing the exact phrase in the description that justifies it. Never invent one
  with no textual basis. Guess "type" from context if the description doesn't state it
  (default to "number").
- requiredProp is [] (empty) when role is not "contained", or when "contained" but
  neither the schema nor the description name any per-shape property.

WRAPPER (how the shape is packaged):
- "raw-geometry": schema top level IS the geometry ({"type":"Polygon","coordinates":[...]})
- "feature": schema top level is one GeoJSON Feature ({"type":"Feature","geometry":...,"properties":...})
- "featurecollection": schema top level is a GeoJSON FeatureCollection — role "union", or
  "contained" wrapped as FeatureCollection
- "feature-array": schema top level is a plain array of Features (role "contained" only)

Never invent a role/wrapper the schema doesn't support.`;

// One example per role, matched to the field being classified instead of a single
// fixed example always sent regardless of fit — a model classifying a "single" Point
// gains nothing from (and may get confused by) an example that's actually "contained".
const EXAMPLES = {
  single: {
    field: '{"title":"Sensor Location","description":"The single point where the monitoring sensor is installed.","minOccurs":1,"maxOccurs":1,"schema":{"type":"object","required":["type","coordinates"],"properties":{"type":{"const":"Point"},"coordinates":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"number"}}}}}',
    output: '{"role":"single","wrapper":"raw-geometry","requiredProp":[],"drawTools":["marker"]}',
  },
  union: {
    field: '{"title":"Bounding Box","description":"One or more polygons whose combined area defines the region of interest.","minOccurs":1,"maxOccurs":"unbounded","schema":{"type":"object","required":["type","features"],"properties":{"type":{"const":"FeatureCollection"},"features":{"type":"array","items":{"type":"object","required":["type","geometry"],"properties":{"type":{"const":"Feature"},"geometry":{"type":"object"}}}}}}}',
    output: '{"role":"union","wrapper":"featurecollection","requiredProp":[],"drawTools":["polygon","rectangle","circle"]}',
  },
  contained: {
    field: '{"title":"Zone Assessment","description":"Optional polygons, each rated by category and risk score.","minOccurs":0,"maxOccurs":1,"schema":{"type":"object","required":["type","features"],"properties":{"type":{"const":"FeatureCollection"},"features":{"type":"array","items":{"type":"object","required":["type","geometry","properties"],"properties":{"type":{"const":"Feature"},"geometry":{"type":"object"},"properties":{"type":"object","required":["category","risk_score"],"properties":{"category":{"type":"integer"},"risk_score":{"type":"number"}}}}}}}}}',
    output: '{"role":"contained","wrapper":"featurecollection","requiredProp":[{"key":"category","type":"integer","inferred":false},{"key":"risk_score","type":"number","inferred":false}],"drawTools":["polygon","rectangle","circle"]}',
  },
  containedInferred: {
    field: '{"title":"Additional Canopy Input","description":"Optional polygons for extra tree canopy areas not in the public dataset. The process reads the canopy height from the feature property named by height_column.","minOccurs":0,"maxOccurs":1,"schema":{"type":"object","required":["type","features"],"properties":{"type":{"const":"FeatureCollection"},"features":{"type":"array","items":{"type":"object","required":["type","geometry","properties"],"properties":{"type":{"const":"Feature"},"geometry":{"type":"object"},"properties":{"type":"object","additionalProperties":true}}}}}}}',
    output: '{"role":"contained","wrapper":"featurecollection","requiredProp":[{"key":"height","type":"number","inferred":true,"reason":"description says the process reads canopy height from the property named by height_column"}],"drawTools":["polygon","rectangle","circle"]}',
  },
  mixedGeometryCollection: {
    field: '{"title":"Access Points And Routes","description":"Points of interest and the access routes connecting them — may include both standalone points and lines.","minOccurs":1,"maxOccurs":1,"schema":{"type":"object","required":["type","geometries"],"properties":{"type":{"const":"GeometryCollection"},"geometries":{"type":"array","items":{"type":"object"}}}}}',
    output: '{"role":"single","wrapper":"raw-geometry","requiredProp":[],"drawTools":["marker","polyline"]}',
  },
  unrecognizedNestedArray: {
    field: '{"title":"Exotic Shape","description":"A deeply nested structure of raw coordinate rings with no standard GeoJSON envelope at any level. Each ring is a list of [lon, lat] points.","minOccurs":1,"maxOccurs":1,"schema":{"type":"object","properties":{"coordinates":{"type":"array","items":{"type":"array","items":{"type":"array","items":{"type":"array","items":{"type":"number"}}}}}}}}',
    output: '{"role":"unrecognized","wrapper":"raw-geometry","requiredProp":[],"drawTools":["polygon"],"reason":"The schema is not a standard GeoJSON structure (no Feature/FeatureCollection/geometry envelope).","nestedArrayShape":{"nestingDepth":4,"unitSize":2,"labels":["shape","ring group","ring","point"]}}',
  },
};

// A bare array nested >=2 levels deep with plain numbers at the bottom, and nothing
// recognizable (Feature/FeatureCollection/"geometry") anywhere in the schema — the
// same shape sanitizeLlmGeoField.js can't resolve a role for either, hence the
// "unrecognizedNestedArray" example instead of guessing at single/union/contained.
function hasUnresolvableNestedArrayShape(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) return false;
  if ('geometry' in schema.properties || 'features' in schema.properties) return false;
  if (schema.properties.type && typeof schema.properties.type.const === 'string') return false;
  return Object.values(schema.properties).some(prop => {
    let depth = 0;
    let cur = prop;
    while (cur && cur.type === 'array' && cur.items) { depth++; cur = cur.items; }
    return depth >= 2 && cur && cur.type === 'number';
  });
}

// Picks the example whose role the field's OWN schema shape already implies — the
// same structural signals sanitizeLlmGeoField.js uses to validate the model's answer,
// so the example shown is never a guess, just a role we can already derive directly.
// "containedInferred" needs its own trigger: a schema with no required per-item
// properties at all, but a description that still names one (e.g. "height_column").
function pickExampleRole(def) {
  const schema = def.schema;
  const props = findRequiredProps(schema);
  if (props.length > 0) return 'contained';
  if (/\b\w+_column\b|named by|propert(y|ies) (named|specified)/i.test(def.description || '')) return 'containedInferred';
  // GeometryCollection has no single fixed shape by definition — the clearest trigger
  // for showing the drawTools example instead of assuming one tool fits.
  if (schema && schema.properties && schema.properties.type && schema.properties.type.const === 'GeometryCollection') {
    return 'mixedGeometryCollection';
  }
  if (hasUnresolvableNestedArrayShape(schema)) return 'unrecognizedNestedArray';
  if (isRepeatable(def.maxOccurs)) return 'union';
  return 'single';
}

function buildOllamaGeoPrompt(name, def, process, otherFieldNames) {
  const fieldJson = JSON.stringify({
    title: def.title,
    description: def.description,
    minOccurs: def.minOccurs,
    maxOccurs: def.maxOccurs,
    schema: def.schema,
  }, null, 2);

  const contextLine = otherFieldNames.length
    ? `\n\nContext: this field is part of the same form as the "${process.id}" process, along with ${otherFieldNames.map(n => `"${n}"`).join(', ')} already handled separately.`
    : '';

  const example = EXAMPLES[pickExampleRole(def)];

  return `${GEO_ROLES_BLOCK}

Example:
${example.field}
Correct output: ${example.output}

Field to classify:
name: ${name}
${fieldJson}${contextLine}`;
}

module.exports = { buildOllamaGeoPrompt };
