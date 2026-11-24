const fs = require('fs');
const path = require('path');
const { generateHtml } = require('./lib/generateHtml');

const SCRATCH = 'C:/Users/GIODAC~1/AppData/Local/Temp/claude/c--Users-giodaciern-Documents-OgcHtml-AI/39a1d05a-cf8f-4518-8c8a-4c7276523453/scratchpad';
const OUT_DIR = path.join(__dirname, 'out_real');
fs.mkdirSync(OUT_DIR, { recursive: true });

const files = fs.readdirSync(SCRATCH).filter(f => f.startsWith('process_') && f.endsWith('.json'));

async function main() {
  for (const f of files) {
    const proc = JSON.parse(fs.readFileSync(path.join(SCRATCH, f), 'utf8'));
    console.log(`\n=== ${proc.title || proc.id} ===`);
    try {
      const { html, log } = await generateHtml(proc, { model: 'qwen2.5-coder:1.5b' });
      console.log('log:', JSON.stringify(log));
      const outPath = path.join(OUT_DIR, `${proc.id}.html`);
      fs.writeFileSync(outPath, html);
      console.log('written:', outPath);
    } catch (err) {
      console.error('FAILED:', err.stack);
    }
  }
}
main();
