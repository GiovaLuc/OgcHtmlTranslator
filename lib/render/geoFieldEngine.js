// Assembla lo script del motore geo lato browser a partire da client/geoFieldEngine.
// client.js (JS browser puro, letto via fs.readFileSync) più i descrittori campo della pagina.
// Pipeline: chiamato da geoRenderer.js quando il processo ha campi geometrici, iniettando i descrittori di questa pagina (da describeGeoField) nella chiamata di avvio dello script.
const fs = require('fs');
const path = require('path');

const CLIENT_SOURCE = fs.readFileSync(
  path.join(__dirname, 'client', 'geoFieldEngine.client.js'), 'utf8'
);

function buildGeoFieldEngineScript(fields) {
  return `${CLIENT_SOURCE}\n\ninitGeoFields(${JSON.stringify(fields)});`;
}

module.exports = { buildGeoFieldEngineScript };
