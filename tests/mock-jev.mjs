#!/usr/bin/env node
// Fake TypeSafe endpoint for tests that need to see exactly what semgrep sends, deterministically and for
// free. Answers every question with noul:1 (always matches) and appends each request's questions to LOG_PATH,
// one JSON object per line. Usage: node mock-jev.mjs <log-path> ; prints the port it listens on, then waits.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const logPath = process.argv[2];
writeFileSync(logPath, '');
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const { questions } = JSON.parse(Buffer.concat(chunks));
    appendFileSync(logPath, `${JSON.stringify(questions)}\n`);
    const answers = Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 1 }]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers }));
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
