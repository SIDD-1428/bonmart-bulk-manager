require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireAdmin } = require('./auth');
const { buildPlan, commitPlan } = require('./importer');

const app = express();
const port = Number(process.env.PORT || 8080);
const maxMb = Number.isFinite(Number(process.env.MAX_UPLOAD_MB))
  ? Math.min(10, Math.max(1, Number(process.env.MAX_UPLOAD_MB)))
  : 5;
const allowedFile = (name) => /\.(csv|xlsx)$/i.test(name || '');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    callback(allowedFile(file.originalname) ? null : new Error('Choose a .csv or .xlsx file.'), allowedFile(file.originalname));
  },
});

app.use(helmet({ contentSecurityPolicy: false }));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/preview', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a CSV or Excel workbook.' });
    const plan = await buildPlan(req.file.buffer, req.file.originalname);
    res.json({
      digest: crypto.createHash('sha256').update(req.file.buffer).digest('hex'),
      planDigest: crypto.createHash('sha256').update(JSON.stringify(plan.operations)).digest('hex'),
      totalRows: plan.totalRows,
      createCount: plan.createCount,
      updateCount: plan.updateCount,
      operations: plan.operations,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/commit', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a CSV or Excel workbook.' });
    if (req.body.confirm !== 'IMPORT') return res.status(400).json({ error: 'Explicit confirmation required.' });

    const digest = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    if (digest !== req.body.digest) return res.status(409).json({ error: 'File differs from preview. Preview again.' });

    const plan = await buildPlan(req.file.buffer, req.file.originalname);
    const planDigest = crypto.createHash('sha256').update(JSON.stringify(plan.operations)).digest('hex');
    if (planDigest !== req.body.planDigest) return res.status(409).json({ error: 'Import plan changed. Preview again.' });
    if (plan.totalRows !== Number(req.body.totalRows) ||
        plan.createCount !== Number(req.body.createCount) ||
        plan.updateCount !== Number(req.body.updateCount)) {
      return res.status(409).json({ error: 'Import plan changed. Preview again.' });
    }

    await commitPlan(plan.plan);
    res.json({
      ok: true,
      message: `Import complete: ${plan.createCount} created, ${plan.updateCount} updated.`,
      totalRows: plan.totalRows,
      createCount: plan.createCount,
      updateCount: plan.updateCount,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.use((error, req, res, next) => {
  const tooLarge = error.code === 'LIMIT_FILE_SIZE';
  res.status(tooLarge ? 413 : 400).json({
    error: tooLarge ? `File exceeds ${maxMb} MB.` : error.message || 'Request failed.',
  });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(__dirname, '..', 'dist');
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(port, () => console.log(`BonMart Bulk Manager listening on ${port}`));
