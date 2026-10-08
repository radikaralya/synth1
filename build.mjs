import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const entry of ['index.html', 'stylesheets/synth.css', 'javascripts/synth.js', 'images/background.jpg', 'fonts']) {
  cpSync(entry, `dist/${entry}`, { recursive: true });
}
console.log('SYN†H: static build ready in dist/');
