// A stand-in for Jev, for tests/offline.sh. A line scores 0.05 unless it contains the meaning verbatim; then it
// scores 0.9, or N when the line carries "@N" (e.g. "a cat @0.4"). "@drop" answers without a noul;
// "@err" in any line fails the request with a 400 and a long body holding an escape sequence. Each request takes 30ms, so -j shows up;
// "@slow" in any line makes it 400ms, so the spinner (drawn after 300ms) shows up.
// GET returns {"count", "asked", "max", "auth", "model"}: judging requests and questions so far, most requests in flight at once, the last
// authorization header and model; GET /reset also zeroes them. Prints the port it listens on.
import { createServer } from 'node:http';

let count = 0, asked = 0, inFlight = 0, max = 0, auth = null, model = null;
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.end(JSON.stringify({ count, asked, max, auth, model }));
    if (req.url === '/reset') count = asked = max = 0, auth = model = null;
    return;
  }
  let body = '';
  for await (const c of req) body += c;
  const { state, questions, model: sentModel } = JSON.parse(body);
  count++;
  asked += Object.keys(questions).length;
  max = Math.max(max, ++inFlight);
  auth = req.headers.authorization ?? null, model = sentModel;
  await new Promise(r => setTimeout(r, Object.values(state).some(l => String(l).includes('@slow')) ? 400 : 30));
  inFlight--;
  const answers = {};
  if (Object.values(state).some(l => String(l).includes('@err'))) { // an error body a hostile server might send
    res.statusCode = 400;
    return res.end('bad\x1b[31m request ' + 'x'.repeat(1000));
  }
  for (const [k, { instructions }] of Object.entries(questions)) {
    const m = instructions.match(/^Does line (L\d+) match the meaning: "(.*)"\?$/s);
    const line = m ? state[m[1]] : '';
    if (String(line).includes('@drop')) { answers[k] = {}; continue; } // an answer without noul
    answers[k] = { noul: m && line.includes(m[2]) ? Number(line.match(/@([\d.]+)/)?.[1] ?? 0.9) : 0.05 };
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ answers, usage: { input_tokens: 1 } }));
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
