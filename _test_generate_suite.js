// Genera un set di processi OGC di test, uno per caso rilevante delle modifiche
// recenti (geojson generico per geometry type, bbox 2D/3D, geo-unknown via LLM,
// campi scalari misti), più i 6 processi reali di data/processes.json. Scrive ogni
// pagina HTML in out_suite/ e un indice in out_suite/_index.html.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'out_suite');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Casi sintetici, uno per feature recente ──────────────────────────────────
// Dichiarati PRIMA del mock di fetch sotto, perché quel mock deve sapere a quale
// campo appartiene l'id passato da CLI (findFieldNameForCaseId, subito dopo
// questo array) prima di poter decidere quale chiamata lasciare passare.
const SYNTHETIC_CASES = [
  {
    id: 'test-point-raw-geometry',
    title: 'Test: Point geometry grezzo',
    description: 'Verifica che una geometria Point grezza (non Polygon, non wrappata) sia riconosciuta staticamente e disegnata sulla mappa.',
    inputs: {
      sensor_location: {
        title: 'Sensor Location',
        description: 'The single point where the monitoring sensor is installed.',
        minOccurs: 1, maxOccurs: 1,
        schema: {
          type: 'object', required: ['type', 'coordinates'],
          properties: {
            type: { const: 'Point' },
            coordinates: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
          },
        },
      },
    },
  },
  {
    id: 'test-linestring-raw-geometry',
    title: 'Test: LineString geometry grezzo',
    description: 'Verifica che una geometria LineString sia riconosciuta staticamente (non solo Polygon).',
    inputs: {
      route: {
        title: 'Evacuation Route',
        description: 'A single evacuation route line.',
        minOccurs: 1, maxOccurs: 1,
        schema: {
          type: 'object', required: ['type', 'coordinates'],
          properties: {
            type: { const: 'LineString' },
            coordinates: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
          },
        },
      },
    },
  },
  {
    id: 'test-explicit-geojson-format',
    title: 'Test: format geojson-geometry esplicito',
    description: 'Verifica che il marcatore schema.format === "geojson-geometry" sia riconosciuto senza bisogno di type.const.',
    inputs: {
      area: {
        title: 'Generic Area',
        description: 'Any GeoJSON geometry, marked explicitly via format.',
        minOccurs: 1, maxOccurs: 1,
        schema: { type: 'object', format: 'geojson-geometry', properties: { coordinates: { type: 'array' } } },
      },
    },
  },
  {
    id: 'test-bbox-2d',
    title: 'Test: Bounding Box 2D',
    description: 'Verifica il bbox classico a 4 numeri [minX, minY, maxX, maxY], disegnato come rettangolo.',
    inputs: {
      bbox: {
        title: 'Bounding Box',
        description: 'Bounding box defining the area of analysis, expressed as [minX, minY, maxX, maxY].',
        minOccurs: 1, maxOccurs: 1,
        schema: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
      },
    },
  },
  {
    id: 'test-bbox-3d',
    title: 'Test: Bounding Box 3D',
    description: 'Verifica il bbox esteso a 6 numeri [minX, minY, minZ, maxX, maxY, maxZ], con rettangolo 2D + input minZ/maxZ.',
    inputs: {
      extent: {
        title: '3D Extent',
        description: 'Bounding volume including elevation range, expressed as [minX, minY, minZ, maxX, maxY, maxZ].',
        minOccurs: 1, maxOccurs: 1,
        schema: { type: 'array', minItems: 6, maxItems: 6, items: { type: 'number' } },
      },
    },
  },
  {
    id: 'test-mixed-scalar-geo',
    title: 'Test: campi misti scalari + geo',
    description: 'Verifica una combinazione di campi scalari comuni (enum, number, boolean, string) insieme a un campo geo semplice.',
    inputs: {
      city: {
        title: 'City', description: 'Target city.', minOccurs: 1, maxOccurs: 1,
        schema: { type: 'string', enum: ['Leuven', 'Cluj-Napoca'] },
      },
      threshold: {
        title: 'Threshold', description: 'A numeric threshold.', minOccurs: 1, maxOccurs: 1,
        schema: { type: 'number', minimum: 0, maximum: 100 },
      },
      include_buffer: {
        title: 'Include Buffer', description: 'Whether to include a buffer zone.', minOccurs: 0, maxOccurs: 1,
        schema: { type: 'boolean' },
      },
      notes: {
        title: 'Notes', description: 'Free-text notes.', minOccurs: 0, maxOccurs: 1,
        schema: { type: 'string' },
      },
      study_area: {
        title: 'Study Area', description: 'The polygon area of analysis.', minOccurs: 1, maxOccurs: 1,
        schema: {
          type: 'object', required: ['type', 'geometry', 'properties'],
          properties: {
            type: { const: 'Feature' },
            geometry: { type: 'object', required: ['type', 'coordinates'], properties: { type: { const: 'Polygon' }, coordinates: { type: 'array' } } },
            properties: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          },
        },
      },
    },
  },
  {
    id: 'test-geo-unknown-multipolygon',
    title: 'Test: MultiPolygon via LLM (geo-unknown)',
    description: 'Un campo geo con forma non riconosciuta staticamente (GeometryCollection), instradato al path LLM di classificazione. Caso "single", nessuna property.',
    inputs: {
      affected_zones: {
        title: 'Affected Zones',
        description: 'The single area affected, drawn as one shape and submitted once — not multiple separate shapes.',
        minOccurs: 1, maxOccurs: 1,
        schema: {
          type: 'object', required: ['type', 'geometries'],
          properties: {
            type: { const: 'GeometryCollection' },
            geometries: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  },
  {
    id: 'test-geo-unknown-multiprop',
    title: 'Test: multi-property via LLM (geo-unknown, contained)',
    description: 'Un campo "contained" con DUE property richieste dallo schema (category, risk_score) — verifica che l\'LLM le restituisca entrambe, non solo la prima.',
    inputs: {
      risk_zones: {
        title: 'Risk Zones',
        description: 'Distinct polygon zones, each rated by category and numeric risk score.',
        minOccurs: 0, maxOccurs: 1,
        schema: {
          type: 'object', required: ['type', 'features'],
          properties: {
            type: { const: 'FeatureCollection' },
            features: {
              type: 'array',
              items: {
                type: 'object', required: ['type', 'geometry', 'properties'],
                properties: {
                  type: { const: 'Feature' },
                  geometry: { type: 'object', required: ['type', 'coordinates'], properties: { type: { const: 'Polygon' }, coordinates: { type: 'array' } } },
                  properties: {
                    type: 'object', required: ['category', 'risk_score'],
                    properties: { category: { type: 'integer' }, risk_score: { type: 'number', minimum: 0, maximum: 10 } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'test-geo-unknown-inferred-prop',
    title: 'Test: property inferita dalla description via LLM (geo-unknown)',
    description: 'Caso reale canopy_input/height_column, ma con uno schema volutamente ambiguo (nessun "const" su type/Feature/FeatureCollection, così il classificatore statico non può già risolverlo e il campo cade su geo-unknown). Lo schema NON dichiara "height" in required, ma la description dice che il processo legge l\'altezza dalla property indicata da height_column. Verifica che l\'LLM la aggiunga come inferred:true.',
    inputs: {
      canopy_input: {
        title: 'Additional Canopy Input',
        description: 'Optional collection of one or more valid Polygon shapes representing additional tree canopy areas not in the public dataset. If present, the process reads the canopy height from the shape property specified by height_column.',
        minOccurs: 0, maxOccurs: 1,
        schema: {
          type: 'object', required: ['type', 'features'],
          properties: {
            type: { type: 'string' },
            features: {
              type: 'array',
              items: {
                type: 'object', required: ['type', 'geometry', 'properties'],
                properties: {
                  type: { type: 'string' },
                  geometry: { type: 'object', required: ['type', 'coordinates'], properties: { type: { type: 'string' }, coordinates: { type: 'array' } } },
                  properties: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'test-geo-unknown-unrecognized',
    title: 'Test: forma genuinamente nuova via LLM (geo-unknown, unrecognized)',
    description: 'Un campo con una property "coordinates" (basta a far sì che looksGeoJsonShaped lo instradi a geo-unknown, vedi fieldRenderer.js) ma avvolta in una forma che non corrisponde a nessun role/wrapper noto (array annidato di anelli di coordinate, senza alcun envelope Feature/FeatureCollection/geometry a nessun livello). Verifica che l\'LLM dichiari role:"unrecognized" invece di forzare una categoria sbagliata, degradando al fallback testuale.',
    inputs: {
      exotic_shape: {
        title: 'Exotic Shape',
        description: 'A deeply nested structure of raw coordinate rings with no standard GeoJSON envelope at any level — genuinely novel, not matching any known pattern.',
        minOccurs: 1, maxOccurs: 1,
        schema: {
          type: 'object',
          properties: {
            coordinates: {
              type: 'array',
              items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'number' } } } },
            },
          },
        },
      },
    },
  },
  {
    id: 'test-geo-unknown-drawtools',
    title: 'Test: scelta drawTools via LLM (GeometryCollection misto)',
    description: 'Un campo GeometryCollection con description che menziona ESPLICITAMENTE sia punti sia linee — extractGeometryType non puo\' decidere da solo (GeometryCollection e\' ambiguo per definizione), quindi la scelta del/i tool di disegno (marker/polyline) passa all\'LLM, leggendo la description. Verifica che drawTools nella risposta validata rifletta questa lettura.',
    inputs: {
      access_points_and_routes: {
        title: 'Access Points And Routes',
        description: 'Points of interest (entrances, checkpoints) and the access routes connecting them. The map should let the user place individual points as well as draw connecting lines.',
        minOccurs: 1, maxOccurs: 1,
        schema: {
          type: 'object', required: ['type', 'geometries'],
          properties: {
            type: { const: 'GeometryCollection' },
            geometries: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  },
];

// Casi che richiedono una chiamata LLM reale (lenta su starcoder2:instruct). Passa
// l'id come primo argomento CLI per generarne uno solo per volta, es.:
//   node _test_generate_suite.js test-geo-unknown-multiprop
// Senza argomento, nessun caso LLM viene eseguito (solo quelli statici, istantanei).
const LLM_CASE_IDS = new Set([
  'test-geo-unknown-multipolygon',
  'test-geo-unknown-multiprop',
  'test-geo-unknown-inferred-prop',
  'test-geo-unknown-unrecognized',
  'test-geo-unknown-drawtools',
]);
const onlyLlmCaseId = process.argv[2] || null;

// Il caso richiesto via CLI ha esattamente un campo nei suoi inputs (per design dei
// casi sopra) — questo è il nome che il mock di fetch userà per riconoscere quale
// prompt lasciare passare a Ollama per davvero.
function findFieldNameForCaseId(caseId) {
  const proc = SYNTHETIC_CASES.find(p => p.id === caseId);
  return proc ? Object.keys(proc.inputs)[0] : null;
}

// Mocka SEMPRE fetch, qualunque sia l'argomento CLI — altrimenti un campo LLM
// incidentale che non è quello richiesto (es. output_options del 15-Minutes City,
// un LLM scalare non "geo-unknown") chiamerebbe comunque Ollama per davvero,
// aggiungendo minuti morti prima di arrivare al caso che si vuole effettivamente
// generare. Il mock guarda il PROMPT stesso: solo se contiene il nome del campo
// richiesto via CLI lascia passare la vera chiamata di rete; ogni altro campo
// fallisce subito e degrada al fallback. Il mock va installato PRIMA di
// require('./lib/generateHtml'): ollamaRenderer.js legge `fetch` una sola volta
// al require, non ad ogni chiamata — per questo generateHtml è require()d qui,
// dopo il mock, invece che in testa al file.
const targetFieldName = onlyLlmCaseId ? findFieldNameForCaseId(onlyLlmCaseId) : null;
const realFetch = globalThis.fetch || require('node-fetch');
global.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  const promptMentionsTargetField = targetFieldName && typeof body.prompt === 'string' && body.prompt.includes(`name: ${targetFieldName}`);
  if (promptMentionsTargetField) return realFetch(url, opts);
  throw new Error(`Ollama disabled for this field in this test run (only "${targetFieldName || '(none requested)'}" is allowed to call it for real)`);
};

const { generateHtml } = require('./lib/generateHtml');

async function run(proc, model) {
  console.log(`\n=== ${proc.title || proc.id} ===`);
  const startedAt = Date.now();
  try {
    const { html, log } = await generateHtml(proc, model ? { model } : {});
    console.log('log:', JSON.stringify(log));
    console.log(`durata: ${Date.now() - startedAt}ms`);
    fs.writeFileSync(path.join(OUT_DIR, `${proc.id}.html`), html);
    return { id: proc.id, title: proc.title || proc.id, ok: true, log };
  } catch (err) {
    console.error('FAILED:', err.stack);
    return { id: proc.id, title: proc.title || proc.id, ok: false, error: err.message };
  }
}

// Risultati di run precedenti (es. un altro caso LLM già generato in un giro
// separato), letti da un manifest JSON a fianco dell'indice — così generare un solo
// caso LLM alla volta non fa sparire gli altri dall'indice finale.
const MANIFEST_PATH = path.join(OUT_DIR, '_manifest.json');
function loadPreviousResults() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

async function main() {
  const previous = loadPreviousResults();
  const results = [];

  // Processi reali — sempre rigenerati (istantanei)
  const realProcesses = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'processes.json'), 'utf8'));
  for (const proc of realProcesses) {
    results.push(await run(proc));
  }

  // Casi sintetici statici — sempre rigenerati (istantanei)
  for (const proc of SYNTHETIC_CASES.filter(p => !LLM_CASE_IDS.has(p.id))) {
    results.push(await run(proc));
  }

  // Casi LLM: solo quello richiesto via CLI arg, se presente. Gli altri vengono
  // ripresi dal manifest della run precedente (se già generati) invece di sparire.
  for (const proc of SYNTHETIC_CASES.filter(p => LLM_CASE_IDS.has(p.id))) {
    if (proc.id === onlyLlmCaseId) {
      results.push(await run(proc));
    } else {
      const prev = previous.find(r => r.id === proc.id);
      if (prev) results.push(prev);
      else results.push({ id: proc.id, title: proc.title, ok: false, error: '(non ancora generato — passa questo id come argomento CLI)' });
    }
  }

  // Indice
  const rows = results.map(r => `
    <tr>
      <td>${r.ok ? '✅' : '❌'}</td>
      <td>${r.ok ? `<a href="${r.id}.html" target="preview">${r.title}</a>` : r.title}</td>
      <td><code>${r.id}</code></td>
      <td>${r.ok ? (r.log || []).map(l => `${l.field}:${l.kind || l.source}`).join(', ') : `<span style="color:#c53030">${r.error}</span>`}</td>
    </tr>`).join('\n');

  const indexHtml = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<title>Suite di test — OgcHtmlTranslator</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; height: 100vh; }
  .sidebar { width: 480px; overflow-y: auto; padding: 16px; border-right: 1px solid #d0d7de; box-sizing: border-box; }
  .sidebar h1 { font-size: 16px; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td { padding: 6px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
  code { font-size: 10px; color: #888; }
  a { color: #3a7bd5; text-decoration: none; }
  a:hover { text-decoration: underline; }
  iframe { flex: 1; border: none; }
</style>
</head>
<body>
  <div class="sidebar">
    <h1>Suite di test (${results.filter(r => r.ok).length}/${results.length} OK)</h1>
    <table>
      <tr><th></th><th>Processo</th><th>ID</th><th>Log</th></tr>
      ${rows}
    </table>
  </div>
  <iframe name="preview" src="${results.find(r => r.ok)?.id || ''}.html"></iframe>
</body>
</html>`;

  fs.writeFileSync(path.join(OUT_DIR, '_index.html'), indexHtml);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(results, null, 2));
  console.log(`\n\nIndice scritto: ${path.join(OUT_DIR, '_index.html')}`);
  console.log(`Risultati: ${results.filter(r => r.ok).length}/${results.length} OK`);
}

main().catch(e => { console.error(e); process.exit(1); });
