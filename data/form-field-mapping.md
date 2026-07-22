# OGC → Form Field Mapping

Questo documento descrive come i tipi di campo definiti nella spec OGC vengono tradotti in controlli HTML nel Process Form.

Per ogni tipo è riportato:
- lo **schema OGC** di riferimento (JSON Schema)
- il **controllo HTML** corrispondente con snippet
- lo **snippet JS** per leggere o costruire il valore al submit

I campi geografici (Polygon, Feature, FeatureCollection) sono tutti gestiti con una singola mappa Leaflet + leaflet-draw. La differenza tra i tre tipi è solo nel wrapping del risultato prodotto dal disegno.

I campi che rappresentano un'area principale (es. `study_area`, `bounding_box`) accettano il disegno di **più poligoni**, uniti in un singolo poligono/multipoligono tramite `turf.union`. L'utente può disegnare finché non preme "Done", e il contorno dell'area unita viene ridisegnato in tempo reale sulla mappa (vedi sezione "Campo area principale (union)").

I campi che richiedono più poligoni con una proprietà per feature (array di Feature, FeatureCollection con proprietà) usano la stessa mappa con disegno multiplo: ogni poligono disegnato genera una riga nella lista sottostante dove l'utente assegna l'etichetta (ID intero o valore numerico). Se nello stesso processo è presente anche un campo area principale che li precede, ogni poligono disegnato deve ricadere **all'interno** di quell'area (validato con `turf.booleanContains`); altrimenti viene rifiutato.

Tutti i controlli di disegno (Leaflet Draw) accettano poligono libero, rettangolo e cerchio. Il cerchio (centro + raggio) viene convertito internamente in un poligono approssimato (`turf.circle`) prima di essere unito, validato per contenimento o incluso nel payload, così il risultato è sempre un GeoJSON Polygon coerente con lo schema OGC.

---

## Tipi di campo presenti nelle analisi OGC

---

### string enum
```json
{ "type": "string", "enum": ["Leuven", "Cluj-Napoca"] }
```
Es. `city`, `mode`, `weather` (Preset)

```html
<select name="city">
  <option value="Leuven">Leuven</option>
  <option value="Cluj-Napoca">Cluj-Napoca</option>
</select>
```
```js
const value = form.elements['city'].value; // "Leuven"
```

Se le opzioni sono ≤ 4, in alternativa si usano radio card:
```html
<input type="radio" name="weather" value="Normal Spring Day">
<input type="radio" name="weather" value="Summer Storm">
```
```js
const value = form.elements['weather'].value; // "Normal Spring Day"
```

---

### string libera
```json
{ "type": "string" }
```
Es. `city` in 3-30-300, `name` in Air Filtration

```html
<input type="text" name="city">
```
```js
const value = form.elements['city'].value.trim(); // "Leuven"
```

---

### number
```json
{ "type": "number" }
```
Es. `weather.temperature`, `weather.precipitation`

```html
<input type="number" name="weather.temperature" step="0.1">
```
```js
const value = parseFloat(form.elements['weather.temperature'].value); // 15.5
```

---

### number con range
```json
{ "type": "number", "minimum": 0, "maximum": 100 }
```
Es. `weather.humidity`

```html
<input type="number" name="weather.humidity" min="0" max="100" step="1">
```
```js
const value = parseFloat(form.elements['weather.humidity'].value); // 65
// il browser blocca valori fuori range tramite min/max
```

---

### object numerico con somma vincolata
```json
{
  "type": "object",
  "minProperties": 1,
  "properties": {
    "rain_garden": { "type": "number", "minimum": 0, "maximum": 100 },
    "bioswale":    { "type": "number", "minimum": 0, "maximum": 100 }
  }
}
```
Il vincolo sum = 100 non è espresso nel JSON Schema ma è implicito nella semantica del campo.
Es. `nbs_weights`

```html
<input type="number" name="nbs.rain_garden" min="0" max="100" step="0.1">
<input type="number" name="nbs.bioswale"    min="0" max="100" step="0.1">
<!-- ... -->
<div id="nbs-sum">Totale: <strong>0</strong> / 100</div>
```
```js
// aggiornamento live del totale
const inputs = document.querySelectorAll('[name^="nbs."]');
inputs.forEach(i => i.addEventListener('input', () => {
  const total = [...inputs].reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0);
  document.getElementById('nbs-sum').textContent = `Totale: ${total} / 100`;
}));

// raccolta al submit — la validazione blocca se total ≠ 100
const nbs_weights = {};
inputs.forEach(i => { nbs_weights[i.name.replace('nbs.', '')] = parseFloat(i.value) || 0; });
// { rain_garden: 40, bioswale: 60, ... }
```

---

### GeoJSON Polygon
```json
{
  "type": "object",
  "properties": {
    "type":        { "const": "Polygon" },
    "coordinates": { "type": "array" }
  }
}
```
Es. `polygon` in Water Infiltration

```html
<div id="map"></div>
```
```js
const map = L.map('map').setView([lat, lng], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

const layer = new L.FeatureGroup().addTo(map);
new L.Control.Draw({
  edit: { featureGroup: layer },
  draw: { polygon: true, polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false }
}).addTo(map);

let result = null;
map.on(L.Draw.Event.CREATED, function(e) {
  layer.clearLayers();
  layer.addLayer(e.layer);
  result = e.layer.toGeoJSON().geometry;
  // { "type": "Polygon", "coordinates": [...] }
});
```

> **CSS:** il container della mappa deve avere `height` fissa, `width: 100%` e `overflow: hidden` per evitare che Leaflet espanda il layout quando aggiunge i controlli di disegno.

---
### GeoJSON Feature (con Polygon)
```json
{
  "type": "object",
  "properties": {
    "type":       { "const": "Feature" },
    "geometry":   { "type": "object" },
    "properties": { "type": "object" }
  }
}
```
Es. `study_area` in Air Filtration

Stesso controllo mappa del Polygon. L'unica differenza è nel wrapping del risultato:
`{ "type": "Feature", "geometry": <geometria disegnata>, "properties": {} }`

---

### GeoJSON FeatureCollection
```json
{
  "type": "object",
  "properties": {
    "type":     { "const": "FeatureCollection" },
    "features": { "type": "array" }
  }
}
```
Es. `bounding_box` in 3-30-300

Stesso controllo mappa del Polygon. L'unica differenza è nel wrapping del risultato:
`{ "type": "FeatureCollection", "features": [{ "type": "Feature", "geometry": <geometria disegnata>, "properties": {} }] }`

---

### GeoJSON FeatureCollection con proprietà per feature
Come sopra, ma ogni Feature ha una proprietà numerica obbligatoria nello schema.
Es. `canopy_input` → proprietà `height` (`number`)

Stesso controllo mappa, ripetuto dinamicamente per ogni poligono aggiunto. Ogni mappa produce una Feature con la proprietà aggiuntiva:
`{ "type": "Feature", "geometry": <geometria disegnata>, "properties": { "height": <valore inserito> } }`

Al submit le feature vengono raccolte in un unico FeatureCollection.

---

### array di GeoJSON Feature con etichetta intera
```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "type":       { "const": "Feature" },
      "geometry":   { "type": "object" },
      "properties": {
        "required": ["selected_measure"],
        "properties": {
          "selected_measure": { "type": "integer" }
        }
      }
    }
  }
}
```
Es. `measures` in Air Filtration → proprietà `selected_measure` (`integer`)

Stesso controllo mappa, ripetuto dinamicamente per ogni misura aggiunta. Ogni mappa produce una Feature con la proprietà aggiuntiva:
`{ "type": "Feature", "geometry": <geometria disegnata>, "properties": { "selected_measure": <id inserito> } }`

Al submit le feature vengono raccolte in un array.

---

### Campo area principale (union multi-poligono)
Si applica ai campi Polygon / Feature / FeatureCollection "semplice" (senza proprietà per-feature richieste) quando rappresentano l'area di riferimento di un'analisi.
Es. `study_area` in Air Filtration, `bounding_box` in 3-30-300.

A differenza del caso a singolo poligono, l'utente può disegnare **più poligoni** (anche rettangoli o cerchi) che vengono uniti in un solo poligono/multipoligono:

```js
let items = [];   // { idx, layer, geometry }
let merged = null;

function recomputeMerged() {
  if (items.length === 0) { merged = null; return; }
  let acc = turf.polygon(items[0].geometry.coordinates);
  for (let i = 1; i < items.length; i++) {
    try { acc = turf.union(acc, turf.polygon(items[i].geometry.coordinates)); }
    catch (err) { /* geometria non valida o non sovrapposta: mantieni il risultato accumulato */ }
  }
  merged = acc.geometry;
}
```

Dopo ogni poligono disegnato il contorno unito viene ridisegnato in evidenza sulla mappa (stile tratteggiato), sovrapposto ai poligoni sorgente, così l'utente vede subito il risultato:
```js
L.geoJSON(merged, { style: { color: '#1a1a2e', weight: 3, dashArray: '6 4', fillOpacity: 0 } }).addTo(mergedLayer);
```

Non viene mostrato un elenco testuale dei poligoni (a differenza dei campi con proprietà per-feature): l'unica UI aggiuntiva è un pulsante **"Done"**, nascosto finché non è stato disegnato almeno un poligono, che conferma l'area e sblocca la fase successiva (es. il disegno delle NBS Measures dentro la Study Area):
```html
<button type="button" id="btnDone" style="display:none" onclick="confirmDone()">Done — continue to NBS Measures</button>
```
```js
function confirmDone() {
  if (items.length === 0) return;
  // sblocca la fase successiva della mappa
}
```

Al submit il wrapping segue lo stesso schema del campo semplice (Polygon / Feature / FeatureCollection), usando `merged` al posto della geometria di un singolo disegno.

---

### Cerchio come poligono
Leaflet Draw serializza un cerchio disegnato come `Point` (centro) + raggio, non come `Polygon`. Prima di qualunque uso (union, containment check, payload) va convertito in poligono approssimato:
```js
function layerToPolygonGeometry(layer) {
  if (layer instanceof L.Circle) {
    const center = layer.getLatLng();
    return turf.circle([center.lng, center.lat], layer.getRadius() / 1000, { units: 'kilometers', steps: 64 }).geometry;
  }
  return layer.toGeoJSON().geometry;
}
```
Poligoni e rettangoli disegnati restituiscono già un `Polygon` GeoJSON valido da `layer.toGeoJSON().geometry` e non richiedono conversione.

---

### Valore enum singolo (costante)
```json
{ "type": "string", "enum": ["custom"] }
```
Es. `mode` in Water Infiltration Custom/Preset

Se l'enum ha un solo valore possibile non ha senso mostrare un controllo: il campo non compare nel form e il valore viene iniettato direttamente nel payload al submit.
```js
payload['mode'] = 'custom';
```

---

## Comunicazione con la pagina che ospita il form (iframe)

Ogni form generato è pensato per essere incorporato in un `<iframe>` nel frontend Angular e comunica col parent esclusivamente via `window.postMessage`, senza dipendenze dirette.

### Dal form verso il parent

| Messaggio | Quando | Payload |
|---|---|---|
| `{ type: 'analysis-ready' }` | Appena la mappa Leaflet è inizializzata, prima ancora che l'utente interagisca. | — |
| `{ type: 'analysis-submit', analysisId, data }` | Al submit del form, dopo validazione. | `analysisId` = id del processo OGC; `data` = payload costruito secondo le regole sopra. |
| `{ type: 'analysis-cancel' }` | Click su "Cancel". | — |

### Dal parent verso il form — centrare la mappa

Il form non ha una città/posizione predefinita se non un default fisso (Leuven, `[50.88, 4.70]`). Il parent può indicare dove centrare la mappa in due modi, a seconda di come l'iframe viene caricato:

**1. Query string** (se l'iframe usa `src="<url-del-form>?lat=..&lng=..&zoom=.."`), letta una sola volta all'avvio:
```js
const params = new URLSearchParams(window.location.search);
const lat = parseFloat(params.get('lat'));
const lng = parseFloat(params.get('lng'));
```

**2. `postMessage` a runtime** (funziona sempre, incluso il caso `srcdoc` in cui non esiste un URL con query string). Consigliato attendere `analysis-ready` prima di inviarlo, per essere certi che la mappa esista già:
```js
// lato Angular, dopo aver ricevuto { type: 'analysis-ready' } dall'iframe:
const [lat, lng] = selectedCity.value[0]; // es. da getCitiesFromApi()
iframe.contentWindow.postMessage({ type: 'set-center', lat, lng, zoom: 13 }, '*');
```
Il form ascolta l'evento e ricentra la mappa in qualunque momento, anche dopo il caricamento iniziale:
```js
window.addEventListener('message', function(ev) {
  const msg = ev.data;
  if (!msg || msg.type !== 'set-center') return;
  map.setView([msg.lat, msg.lng], msg.zoom ?? map.getZoom());
});
```
