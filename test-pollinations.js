const fs = require('fs');
async function test() {
  const res = await fetch('https://image.pollinations.ai/prompt/a%20red%20apple%20on%20a%20desk?width=1024&height=1024&nologo=true');
  const buffer = await res.arrayBuffer();
  fs.writeFileSync('/tmp/test-apple.png', Buffer.from(buffer));
  console.log('Downloaded', buffer.byteLength, 'bytes');
}
test();
