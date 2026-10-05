const fs = require('fs');
let code = fs.readFileSync('src/providers/ai-content.js', 'utf8');
code = code.replace(
  "!result.headline.toLocaleLowerCase('pt-BR')",
  "!(result.headline || '').toLocaleLowerCase('pt-BR')"
);
fs.writeFileSync('src/providers/ai-content.js', code);
