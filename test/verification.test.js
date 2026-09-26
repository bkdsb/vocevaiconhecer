import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorialVerifier, extractArticle, isPublicAddress } from '../src/verification.js';

const PRIMARY = 'https://science.nasa.gov/new-observation';
const SECONDARY = 'https://www.reuters.com/science/new-observation';
const QUOTE = 'Researchers observed a faint cloud around the distant planet using two independent instruments.';
const STORY = `${QUOTE} The initial observation requires further study before the physical explanation can be established. The team published its methods and the original instrument measurements for independent review.`;
const NOW = new Date('2026-09-25T10:00:00Z');
const html = (metadata = '<meta property="article:published_time" content="2026-09-22T12:30:00Z">') => `<html><head><title>Real retrieved title</title>${metadata}</head><body><nav>Navigation should not be evidence</nav><article>${STORY}</article><script>Invented secret text</script></body></html>`;
const candidate = (urls = [PRIMARY, SECONDARY]) => ({ topic: 'Observação de uma nuvem planetária', summary: 'Candidate summary is not evidence', category: 'news', sources: urls.map((url) => ({ url, text: 'UNFETCHED SNIPPET', publishedAt: '2026-09-25' })) });
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const page = (body = html(), options = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...options });
const assessment = (urls = [PRIMARY, SECONDARY]) => ({ verdict: 'verified', explanation: 'As páginas confirmam a observação, ainda preliminar.', sources: urls.map((url) => ({ url, isPrimary: true, primaryReason: 'Página da instituição responsável pela observação original.', text: 'FABRICATED MODEL TEXT', publishedAt: '2030-01-01' })), claims: [{ text: 'Pesquisadores observaram uma nuvem tênue; a explicação ainda exige estudo.', sourceUrls: urls, evidenceQuotes: urls.map((url) => ({ url, quote: QUOTE })) }] });
const dependencies = (overrides = {}) => ({ lookupImpl: publicDns, fetchImpl: async () => page(), now: () => NOW, modelCall: async (_message, { label }) => label === 'research-discover' ? { urls: [] } : assessment(), ...overrides });

test('verification returns actual fetched evidence, metadata date and grounded claims; publisher is not automatically primary', async () => {
  const calls = [];
  const verify = createEditorialVerifier({ openclawAiAgent: 'isolated-editor' }, dependencies({ modelCall: async (message, options) => { calls.push({ message, options }); return { text: JSON.stringify(assessment()) }; } }));
  const result = await verify(candidate());
  assert.equal(result.verdict, 'verified');
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].isPrimary, true);
  assert.equal(result.sources[1].isPrimary, false);
  assert.equal(result.sources[0].publishedAt, '2026-09-22T12:30:00.000Z');
  assert.equal(result.sources[0].retrievedAt, NOW.toISOString());
  assert.equal(result.sources[0].retrievalMethod, 'web-fetch');
  assert.equal(result.sources[0].verified, true);
  assert.equal(result.sources[0].text, STORY);
  assert.ok(!result.sources[0].text.includes('FABRICATED'));
  assert.ok(!calls[0].message.includes('UNFETCHED SNIPPET'));
  assert.equal(calls[0].options.agent, 'isolated-editor');
});

test('discovery URLs are independently fetched and search snippets never become evidence', async () => {
  const fetched = []; const agents = [];
  const verify = createEditorialVerifier({ openclawResearchAgent: 'isolated-search', openclawAiAgent: 'isolated-editor' }, dependencies({ fetchImpl: async (url) => { fetched.push(url); return page(); }, modelCall: async (_message, { label, agent }) => { agents.push(agent); return label === 'research-discover' ? { urls: [PRIMARY, SECONDARY], snippet: 'This text is not fetched evidence' } : assessment(); } }));
  const result = await verify(candidate(['https://reddit.com/r/science/post']));
  assert.equal(result.verdict, 'verified');
  assert.deepEqual(fetched, ['https://reddit.com/r/science/post', PRIMARY, SECONDARY]);
  assert.deepEqual(agents, ['isolated-search', 'isolated-editor']);
});

test('private, loopback, mapped, documentation and non-public network ranges are rejected', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.5.1', '192.168.1.2', '100.100.100.200', '198.18.0.1', '203.0.113.4', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001:0db8::1', '2001:0000::1', '2002:7f00:1::1', '3fff::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
});

test('HTTPS allowlist and DNS validation run before requests, including mixed public/private DNS answers', async () => {
  let fetches = 0;
  const verify = createEditorialVerifier({}, dependencies({ lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], fetchImpl: async () => { fetches += 1; return page(); } }));
  const result = await verify(candidate([PRIMARY, 'http://science.nasa.gov/insecure', 'https://science.nasa.gov.evil.test/fake', 'https://user:secret@science.nasa.gov/private', 'https://science.nasa.gov:8443/private', 'https://127.0.0.1/secret']));
  assert.equal(result.verdict, 'unsupported');
  assert.equal(fetches, 0);
  assert.match(result.explanation, /SOURCE_PRIVATE_ADDRESS/);
  assert.match(result.explanation, /SOURCE_HOST_BLOCKED/);
});

test('every redirect revalidates host and resolved addresses before the next request', async () => {
  const fetched = [];
  const verify = createEditorialVerifier({}, dependencies({ lookupImpl: async (hostname) => [{ address: hostname === 'internal.nasa.gov' ? '10.0.0.2' : '8.8.8.8', family: 4 }], fetchImpl: async (url, opts) => { fetched.push(url); assert.equal(opts.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'https://internal.nasa.gov/private' } }); } }));
  const result = await verify(candidate([PRIMARY]));
  assert.equal(result.verdict, 'unsupported');
  assert.deepEqual(fetched, [PRIMARY]);
  assert.match(result.explanation, /SOURCE_PRIVATE_ADDRESS/);
});

test('redirect loops are bounded and off-allowlist destinations are blocked', async () => {
  let fetched = 0;
  const verify = createEditorialVerifier({}, dependencies({ fetchImpl: async () => { fetched += 1; return new Response(null, { status: 302, headers: { location: PRIMARY } }); } }));
  const result = await verify(candidate([PRIMARY]));
  assert.equal(result.verdict, 'unsupported');
  assert.equal(fetched, 4);
  assert.match(result.explanation, /SOURCE_REDIRECT_LIMIT/);
  let redirectedRequests = 0;
  const blocked = await createEditorialVerifier({}, dependencies({ fetchImpl: async () => { redirectedRequests += 1; return new Response(null, { status: 302, headers: { location: 'https://evil.test/source' } }); } }))(candidate([PRIMARY]));
  assert.equal(redirectedRequests, 1);
  assert.match(blocked.explanation, /SOURCE_HOST_BLOCKED/);
});

test('a safe redirect produces evidence under the actual final URL', async () => {
  const result = await createEditorialVerifier({}, dependencies({ fetchImpl: async (url) => url === 'https://science.nasa.gov/old-link' ? new Response(null, { status: 301, headers: { location: PRIMARY } }) : page() }))(candidate(['https://science.nasa.gov/old-link', SECONDARY]));
  assert.equal(result.verdict, 'verified');
  assert.equal(result.sources[0].url, PRIMARY);
});

test('publication dates come only from explicit valid publication metadata, never body or modified dates', () => {
  for (const metadata of ['', '<meta property="article:modified_time" content="2026-09-25"><time datetime="2026-09-24">today</time>', '<meta property="article:published_time" content="2026-02-29">', '<meta property="article:published_time" content="2026-09-31">', '<meta property="article:published_time" content="2026-13-01">', '<meta property="article:published_time" content="September 24">']) assert.equal(extractArticle(html(metadata)).publishedAt, null);
  assert.equal(extractArticle(html('<meta property="article:published_time" content="2024-02-29">')).publishedAt, '2024-02-29T00:00:00.000Z');
  assert.equal(extractArticle(html('<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","datePublished":"2026-09-21"}]}</script>')).publishedAt, '2026-09-21T00:00:00.000Z');
  assert.equal(extractArticle(html('<time itemprop="datePublished" datetime="2026-09-20">')).publishedAt, '2026-09-20T00:00:00.000Z');
  assert.equal(extractArticle(html('<script type="application/ld+json">{"@type":"Organization","datePublished":"2026-09-21"}</script>')).publishedAt, null);
});

test('a missing fetched date stays null even when a model invents publication dates', async () => {
  const result = await createEditorialVerifier({}, dependencies({ fetchImpl: async () => page(html('')) }))(candidate());
  assert.equal(result.verdict, 'verified');
  assert.equal(result.sources[0].publishedAt, null);
});

test('claims without literal supporting quotes or with unfetched URLs cannot be verified', async () => {
  for (const change of [
    (value) => { value.claims[0].evidenceQuotes[0].quote = 'An entirely fabricated statement that never appeared in the page.'; },
    (value) => { value.claims[0].sourceUrls.push('https://www.nasa.gov/unfetched'); },
    (value) => { value.claims[0].evidenceQuotes = []; },
    (value) => { value.claims.push({ text: 'Extra unsupported claim', sourceUrls: [PRIMARY] }); },
  ]) {
    const value = assessment(); change(value);
    const result = await createEditorialVerifier({}, dependencies({ modelCall: async () => value }))(candidate());
    assert.equal(result.verdict, 'unsupported');
    assert.deepEqual(result.sources, []);
    assert.match(result.explanation, /VERIFIER_UNGROUNDED_CLAIMS/);
  }
});

test('non-HTML, oversized and blocked pages fail locally without fabricated evidence', async () => {
  for (const [response, expected] of [
    [() => new Response('binary', { headers: { 'content-type': 'application/pdf' } }), 'SOURCE_TYPE_UNSUPPORTED'],
    [() => page('huge', { headers: { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) } }), 'SOURCE_TOO_LARGE'],
    [() => page('a'.repeat(2 * 1024 * 1024 + 1)), 'SOURCE_TOO_LARGE'],
    [() => page('Access denied', { status: 403 }), 'SOURCE_HTTP_ERROR'],
    [() => page('<html>Please enable JavaScript</html>'), 'SOURCE_EMPTY'],
  ]) {
    const result = await createEditorialVerifier({}, dependencies({ fetchImpl: async () => response() }))(candidate([PRIMARY]));
    assert.equal(result.verdict, 'unsupported');
    assert.match(result.explanation, new RegExp(expected));
    assert.deepEqual(result.sources, []);
  }
});

test('DNS resolution is bounded by the source timeout', async () => {
  let fetched = false;
  const result = await createEditorialVerifier({ researchFetchTimeoutMs: 5 }, dependencies({ lookupImpl: () => new Promise((resolve) => setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 25)), fetchImpl: async () => { fetched = true; return page(); } }))(candidate([PRIMARY]));
  assert.equal(result.verdict, 'unsupported');
  assert.equal(fetched, false);
  assert.match(result.explanation, /SOURCE_TIMEOUT/);
});

test('editor failures and invalid JSON are reported as unsupported instead of crashing the research batch', async () => {
  for (const modelCall of [async () => { throw Object.assign(new Error('Exact model unavailable'), { code: 'AI_UNAVAILABLE' }); }, async () => ({ text: 'null' }), async () => ({ text: '```json\n[]\n```' }), async () => ({ text: 'not JSON' })]) {
    const result = await createEditorialVerifier({}, dependencies({ modelCall }))(candidate());
    assert.equal(result.verdict, 'unsupported');
    assert.deepEqual(result.sources, []);
  }
});
