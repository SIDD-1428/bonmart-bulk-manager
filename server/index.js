require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireAdmin } = require('./auth');
const { buildPlan, commitPlan } = require('./importer');
const { db } = require('./firebase');

const app = express();
const port = Number(process.env.PORT || 8080);
const maxMb = Number.isFinite(Number(process.env.MAX_UPLOAD_MB))
  ? Math.min(10, Math.max(1, Number(process.env.MAX_UPLOAD_MB)))
  : 5;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const allowedFile = (name) => /\.(csv|xlsx)$/i.test(name || '');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    callback(allowedFile(file.originalname) ? null : new Error('Choose a .csv or .xlsx file.'), allowedFile(file.originalname));
  },
});

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Fingerprint only operation identity. The uploaded file digest protects row
// contents; unrelated catalogue edits must not invalidate an import preview.
const planFingerprint = (operations) => sha256(JSON.stringify(
  operations.map(({ operation, sku, documentId }) => ({ operation, sku, documentId }))
));

app.use(helmet({ contentSecurityPolicy: false }));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/preview', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a CSV or Excel workbook.' });

    const plan = await buildPlan(req.file.buffer, req.file.originalname);
    const digest = sha256(req.file.buffer);
    const planDigest = planFingerprint(plan.operations);
    const sessionId = crypto.randomBytes(32).toString('hex');
    const newDocumentIds = Object.fromEntries(
      plan.plan
        .filter((item) => item.operation === 'CREATE')
        .map((item) => [item.sku, item.documentId])
    );
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);

    // Store the server-generated IDs and reviewed plan metadata server-side.
    // Cloud Run instances can change between preview and commit, so this must
    // not live only in process memory or be trusted from the browser.
    await db.collection('importPreviews').doc(sessionId).create({
      uid: req.operator.uid,
      digest,
      planDigest,
      totalRows: plan.totalRows,
      createCount: plan.createCount,
      updateCount: plan.updateCount,
      newDocumentIds,
      status: 'ready',
      createdAt: new Date(),
      expiresAt,
    });

    res.json({
      sessionId,
      digest,
      planDigest,
      totalRows: plan.totalRows,
      createCount: plan.createCount,
      updateCount: plan.updateCount,
      operations: plan.operations,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/commit', requireAdmin, upload.single('file'), async (req, res) => {
  let sessionRef;
  let sessionLocked = false;
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a CSV or Excel workbook.' });
    if (req.body.confirm !== 'IMPORT') return res.status(400).json({ error: 'Explicit confirmation required.' });
    if (!/^[a-f0-9]{64}$/i.test(req.body.sessionId || '')) {
      return res.status(400).json({ error: 'Preview session is missing. Preview the file again.' });
    }

    sessionRef = db.collection('importPreviews').doc(req.body.sessionId);
    const sessionSnapshot = await sessionRef.get();
    if (!sessionSnapshot.exists) return res.status(409).json({ error: 'Preview session expired or not found. Preview again.' });

    const session = sessionSnapshot.data();
    if (session.uid !== req.operator.uid) return res.status(403).json({ error: 'This preview belongs to another admin account.' });
    if (session.status !== 'ready') return res.status(409).json({ error: 'This preview has already been used or is being committed. Preview again.' });
    if (!session.expiresAt || session.expiresAt.toDate().getTime() <= Date.now()) {
      return res.status(409).json({ error: 'Preview expired. Preview the file again.' });
    }

    const digest = sha256(req.file.buffer);
    if (digest !== session.digest || digest !== req.body.digest) {
      return res.status(409).json({ error: 'File differs from preview. Preview again.' });
    }

    // Re-read the catalogue and validate all matches, but reuse the exact IDs
    // allocated during preview. A changed CREATE/UPDATE mapping changes the hash.
    const plan = await buildPlan(req.file.buffer, req.file.originalname, {
      newDocumentIds: session.newDocumentIds || {},
    });
    const planDigest = planFingerprint(plan.operations);
    if (planDigest !== session.planDigest ||
        planDigest !== req.body.planDigest ||
        plan.totalRows !== session.totalRows ||
        plan.createCount !== session.createCount ||
        plan.updateCount !== session.updateCount) {
      return res.status(409).json({ error: 'Catalogue or import plan changed since preview. Preview again.' });
    }

    // Atomically claim the preview so two requests cannot import it twice.
    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(sessionRef);
      if (!latest.exists || latest.data().status !== 'ready' ||
          latest.data().uid !== req.operator.uid ||
          latest.data().expiresAt.toDate().getTime() <= Date.now()) {
        throw new Error('Preview is no longer available. Preview again.');
      }
      transaction.update(sessionRef, { status: 'committing', committingAt: new Date() });
    });
    sessionLocked = true;

    await commitPlan(plan.plan);
    await sessionRef.update({ status: 'completed', completedAt: new Date() });

    res.json({
      ok: true,
      message: `Import complete: ${plan.createCount} created, ${plan.updateCount} updated.`,
      totalRows: plan.totalRows,
      createCount: plan.createCount,
      updateCount: plan.updateCount,
    });
  } catch (error) {
    if (sessionLocked && sessionRef) {
      await sessionRef.update({ status: 'failed', failedAt: new Date() }).catch(() => {});
    }
    const conflict = /Preview is no longer available/.test(error.message);
    res.status(conflict ? 409 : 400).json({ error: error.message || 'Import failed. Preview again.' });
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
