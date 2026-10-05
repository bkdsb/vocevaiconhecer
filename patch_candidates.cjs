const fs = require('fs');
let code = fs.readFileSync('src/research.js', 'utf8');

const regexMap = /const scraplingCandidates = inspirationProfiles\.map\(p => \(\{\s*id: 'fb-' \+ Buffer\.from\(p\.headline\)\.toString\('base64'\)\.substring\(0, 10\),\s*headline: p\.headline,\s*category: p\.category,\s*sourceDate: now\.toISOString\(\),\s*retrievedAt: now\.toISOString\(\),\s*sources: \[\{ url: p\.inspirationUrl, status: 'ok', title: 'Facebook Page Insight' \}\],\s*claims: \[\{ text: p\.headline, sourceIds: \[\] \}\],\s*score: 0\.95[^\}]*\}\)\);/m;

const replMap = `const scraplingCandidates = inspirationProfiles.map(p => ({
    id: 'fb-' + Buffer.from(p.text || 'fb').toString('base64').substring(0, 10),
    topic: p.text,
    category: p.category,
    sourceDate: now.toISOString(),
    retrievedAt: now.toISOString(),
    sources: [{ url: p.url, status: 'ok', title: 'Facebook Page Insight' }],
    claims: [{ text: p.text, sourceIds: [] }],
    score: 0.95
  }));`;

code = code.replace(regexMap, replMap);
fs.writeFileSync('src/research.js', code);
