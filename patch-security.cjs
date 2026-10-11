const fs = require('node:fs');

const serverPath = 'server/index.js';
const appPath = 'src/App.jsx';

let server = fs.readFileSync(serverPath, 'utf8');
let app = fs.readFileSync(appPath, 'utf8');

const changes = [
  [
    'preview response',
    "digest:crypto.createHash('sha256').update(q.file.buffer).digest('hex'),totalRows:p.totalRows",
    "digest:crypto.createHash('sha256').update(q.file.buffer).digest('hex'),planDigest:crypto.createHash('sha256').update(JSON.stringify(p.operations)).digest('hex'),totalRows:p.totalRows"
  ],
  [
    'commit plan verification',
    "const p=await buildPlan(q.file.buffer);if(p.totalRows!==Number(q.body.totalRows)",
    "const p=await buildPlan(q.file.buffer);if(crypto.createHash('sha256').update(JSON.stringify(p.operations)).digest('hex')!==q.body.planDigest)return s.status(409).json({error:'Import plan changed. Preview again.'});if(p.totalRows!==Number(q.body.totalRows)"
  ],
  [
    'frontend plan digest',
    "digest:preview.digest,totalRows:preview.totalRows",
    "digest:preview.digest,planDigest:preview.planDigest,totalRows:preview.totalRows"
  ]
];

for (const [name, oldText, newText] of changes) {
  const target = name === 'frontend plan digest' ? app : server;
  if (!target.includes(oldText)) {
    throw new Error(`Could not find expected code for: ${name}. No files have been written.`);
  }
}

server = server.replace(
  changes[0][1], changes[0][2]
).replace(
  changes[1][1], changes[1][2]
);
app = app.replace(changes[2][1], changes[2][2]);

fs.writeFileSync(serverPath, server);
fs.writeFileSync(appPath, app);
console.log('Security fix applied successfully.');
