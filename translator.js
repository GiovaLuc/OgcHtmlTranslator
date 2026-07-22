// Entry point: webhook analogo a Waze/listener/listener.js — riceve un processo OGC
// (stesso schema di un elemento di GeoCacher-frontend/src/assets/processes.json) via
// POST e risponde con l'HTML del form generato da lib/generateHtml.js.
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { generateHtml } = require('./lib/generateHtml');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;

app.post('/translate', (req, res) => {
  try {
    const html = generateHtml(req.body);
    res.type('html').send(html);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OgcHtmlTranslator listening on port ${PORT}`);
});
