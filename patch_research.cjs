const fs = require('fs');
let code = fs.readFileSync('src/research.js', 'utf8');

const regexInspiration = /const inspirationProfiles = \(scrapling\.profiles \|\| \[\]\)\.flatMap\(\(profile\) => \(profile\.topics \|\| \[\]\)\.slice\(0, 20\)\.map\(\(topic\) => \(\{\n\s*source: profile\.source,\n\s*url: profile\.url,\n\s*category: profile\.category,\n\s*text: topic,\n\s*\}\)\)\);/;

const replInspiration = `const inspirationProfiles = (scrapling.profiles || []).flatMap((profile) => (profile.topics || []).slice(0, 20).map((topic) => ({
    source: profile.source,
    url: profile.url,
    category: profile.category,
    text: typeof topic === 'string' ? topic : topic.text,
    metrics: typeof topic === 'object' && topic.metrics ? topic.metrics : { score: 1000 }
  })));
  // Ordenar pelos mais virais (com mais engajamento) em toda a lista
  inspirationProfiles.sort((a, b) => (b.metrics?.score || 0) - (a.metrics?.score || 0));
`;
code = code.replace(regexInspiration, replInspiration);

// Forçar a instrução de polemico nas pautas urgentes
const regexTopic = /const baseInstruction = `Você é o editor-chefe do Você Vai Conhecer/;
const replTopic = `const baseInstruction = \`Você é o editor-chefe do Você Vai Conhecer, uma página viral do Facebook (curiosidades, ciência, notícias bizarras, mistérios). 
Você está avaliando pautas. Se o assunto for Política, Tecnologia, Guerra ou Atualidades, ELE DEVE SER POLEMICO, VIRAL e capaz de gerar profunda divergência de opiniões nos comentários (sem violar regras da Meta).
\`;
const oldBaseInstruction = \`Você é o editor-chefe do Você Vai Conhecer`;
code = code.replace(regexTopic, replTopic);

fs.writeFileSync('src/research.js', code);
