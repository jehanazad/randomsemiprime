// Assembles index.html from src/. Usage: node build.mjs
// (vendor.min.js is produced by `npm run build:vendor`; it is committed so this step needs no network.)
import fs from 'node:fs';
import crypto from 'node:crypto';

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const vendor = read('src/vendor.min.js');
const core = read('src/core.js');
const words = JSON.parse(read('src/wordlist.json'));
if (words.length !== 2048) throw new Error('wordlist must have 2048 entries');
for (const src of [vendor, core]) if (src.includes('</script')) throw new Error('inline script contains </script');

let html = read('src/index.template.html');
const sub = (marker, text) => {
  if (!html.includes(marker)) throw new Error('marker missing: ' + marker);
  html = html.split(marker).join(text);
};
sub('/* __VENDOR__ */', vendor);
sub('/* __WORDLIST__ */', JSON.stringify(words));
sub('/* __CORE__ */', core);

fs.writeFileSync(new URL('index.html', import.meta.url), html);
const hash = crypto.createHash('sha256').update(html).digest('hex');
console.log('index.html', html.length, 'bytes, sha256', hash);
