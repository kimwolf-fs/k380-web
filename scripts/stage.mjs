import {cpSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '_site');
mkdirSync(out, {recursive: true});
for (const name of readdirSync(root)) {
  if (['index.html', 'styles.css', 'macro-source-editor.js'].includes(name) ||
      (name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) cpSync(join(root,name),join(out,name));
}
cpSync(join(root,'vendor'),join(out,'vendor'),{recursive:true});
writeFileSync(join(out,'.nojekyll'),'');
