const fs = require('fs');
let code = fs.readFileSync('src/research.js', 'utf8');

code = code.replace(
  "for (const candidate of group) {",
  "for (const candidate of group) {\n      if (!candidate || typeof candidate.topic !== 'string') { console.error('BAD CANDIDATE:', candidate); continue; }"
);
fs.writeFileSync('src/research.js', code);
