// Structural signals derived from a field's schema shape, shared between the geo-LLM
// prompt (which picks a matching example) and its validator (which checks the model's
// answer against these same facts) — so the two can never read the schema differently.
// Pipeline: used by ollamaGeoPrompt.js (pick example) and sanitizeLlmGeoField.js (validate role/requiredProp).

// Finds the innermost per-item schema an array/FeatureCollection field draws repeated
// shapes from, and its declared "required" property list — the same structural signal
// classifyField's geo-featurecollection-props / geo-feature-array kinds are built on.
function findRepeatedItemSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'array' && schema.items) return schema.items;
  if (schema.type === 'object' && schema.properties && schema.properties.features) {
    return findRepeatedItemSchema(schema.properties.features);
  }
  return null;
}

// Returns EVERY property named in the per-item schema's own "required" list — not
// just the first — each with the numeric constraints (minimum/maximum/default) its
// own property schema declares, if any. Empty array (not null) when there's no
// per-item "properties"/"required" at all, so callers can treat "no properties" and
// "one property" uniformly as arrays of different length.
function findRequiredProps(schema) {
  const itemSchema = findRepeatedItemSchema(schema);
  const propsSchema = itemSchema && itemSchema.properties && itemSchema.properties.properties;
  if (!propsSchema || !Array.isArray(propsSchema.required) || propsSchema.required.length === 0) {
    return [];
  }
  return propsSchema.required.map(key => {
    const propSchema = (propsSchema.properties && propsSchema.properties[key]) || {};
    const prop = { key, type: propSchema.type === 'integer' ? 'integer' : 'number' };
    if (typeof propSchema.minimum === 'number') prop.minimum = propSchema.minimum;
    if (typeof propSchema.maximum === 'number') prop.maximum = propSchema.maximum;
    if (propSchema.default !== undefined) prop.default = propSchema.default;
    return prop;
  });
}

// Backward-compatible single-property accessor: the FIRST required property, or
// null if there are none. Used where only one property is structurally possible
// (the static classifier's own geo-featurecollection-props/geo-feature-array kinds).
function findRequiredProp(schema) {
  const all = findRequiredProps(schema);
  return all.length > 0 ? all[0] : null;
}

function isRepeatable(maxOccurs) {
  return maxOccurs === 'unbounded' || (typeof maxOccurs === 'number' && maxOccurs > 1);
}

module.exports = { findRepeatedItemSchema, findRequiredProp, findRequiredProps, isRepeatable };
