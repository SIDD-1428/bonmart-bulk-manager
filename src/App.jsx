import React, { useEffect, useMemo, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { auth } from './firebase';

const TEMPLATE =
  'sku,name,price,image,protext,category,rating,unit,stock,maxOrderQty\n' +
  'EXAMPLE001,Example product,25,https://example.com/image.jpg,Example description,"Flour,Suji",0,pack,10,3\n';

function download() {
  const a = document.createElement('a');
  const u = URL.createObjectURL(
    new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8;' })
  );
  a.href = u;
  a.download = 'bonmart-products-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

function Brand() {
  return (
    <div className="brand">
      <img src="/bonmart-logo.png" alt="BonMart logo" className="brand-logo" />
      <span>BonMart</span>
      <small>OPERATIONS</small>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [email, E] = useState('');
  const [password, P] = useState('');
  const [file, F] = useState(null);
  const [preview, V] = useState(null);
  const [loading, L] = useState(false);
  const [error, X] = useState('');
  const [notice, N] = useState('');
  const [confirm, C] = useState(false);
  const [search, S] = useState('');
  const [filter, Q] = useState('ALL');

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
    });
  }, []);

  async function api(endpoint, extra = {}) {
    if (!file) throw Error('Choose a CSV file first.');
    const fd = new FormData();
    fd.append('file', file);
    Object.entries(extra).forEach(([k, v]) => fd.append(k, String(v)));

    const currentUser = auth.currentUser;
    if (!currentUser)
      throw Error('Your session has expired. Please sign in again.');

    const token = await currentUser.getIdToken();
    const r = await fetch('/api/' + endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: fd,
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error || 'Request failed');
    return d;
  }

  async function login(e) {
    e.preventDefault();
    L(true);
    X('');
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      P('');
    } catch (e) {
      X(
        e.code === 'auth/invalid-credential'
          ? 'Email or password is incorrect.'
          : e.message
      );
    } finally {
      L(false);
    }
  }

  async function previewFile() {
    L(true);
    X('');
    N('');
    V(null);
    C(false);
    try {
      V(await api('preview'));
      N('Preview ready. No Firestore changes made.');
    } catch (e) {
      X(e.message);
    } finally {
      L(false);
    }
  }

  async function commit() {
    if (!preview) return;
    L(true);
    X('');
    N('');
    try {
      const r = await api('commit', {
        confirm: 'IMPORT',
        digest: preview.digest,
        planDigest: preview.planDigest,
        totalRows: preview.totalRows,
        createCount: preview.createCount,
        updateCount: preview.updateCount,
      });
      N(r.message);
      V(null);
      F(null);
      C(false);
      const input = document.getElementById('csv');
      if (input) input.value = '';
    } catch (e) {
      X(e.message);
    } finally {
      L(false);
    }
  }

  const ops = useMemo(
    () =>
      preview?.operations?.filter(
        (o) =>
          (filter === 'ALL' || o.operation === filter) &&
          `${o.sku} ${o.name} ${o.category} ${o.documentId}`
            .toLowerCase()
            .includes(search.toLowerCase())
      ) || [],
    [preview, filter, search]
  );

  if (!ready) {
    return <div className="loading">Loading secure workspace…</div>;
  }

  if (!user) {
    return (
      <main className="login">
        <section className="hero">
          <Brand />
          <div>
            <label>PRODUCT OPERATIONS</label>
            <h1>
              Bulk updates.
              <br />
              <em>Less busywork.</em>
            </h1>
            <p>
              Import product catalogues confidently, review every change,
              and keep your store data consistent.
            </p>
          </div>
          <small>SECURE WORKSPACE · FIRESTORE ON SERVER</small>
        </section>

        <form className="loginform" onSubmit={login}>
          <label>WELCOME BACK</label>
          <h2>Sign in to BonMart</h2>
          <p>Use your approved staff account.</p>

          <span>Email address</span>
          <input
            type="email"
            value={email}
            onChange={(e) => E(e.target.value)}
            required
          />

          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => P(e.target.value)}
            required
          />

          {error && <div className="error">{error}</div>}

          <button disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in securely →'}
          </button>

          <small>Access is limited to verified, authorized accounts.</small>
        </form>
      </main>
    );
  }

  return (
    <div className="layout">
      <aside>
        <Brand />
        <p>WORKSPACE</p>
        <div className="nav">▦　Product importer</div>
        <footer>
          ● Protected session
          <br />
          　CSV tools · Firestore
        </footer>
      </aside>

      <main>
        <header>
          <div>
            <small>WORKSPACE / CATALOGUE</small>
            <h1>Bulk product manager</h1>
          </div>
          <div>
            {user.email}{' '}
            <button className="quiet" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </div>
        </header>

        <section className="intro">
          <div>
            <h2>Import your product catalogue</h2>
            <p>
              Upload a CSV, review proposed changes, then import when
              everything looks right.
            </p>
          </div>
          <button className="secondary" onClick={download}>
            ↓ Download CSV template
          </button>
        </section>

        <div className="steps">
          <b>1　Upload</b> ───{' '}
          <b className={preview ? 'active' : ''}>2　Review</b> ───{' '}
          <b>3　Import</b>
        </div>

        <section className="card">
          <h3>↑　Upload CSV file</h3>
          <p>Use the BonMart template to avoid formatting errors.</p>

          <label className="drop">
            {file ? file.name : 'Drop your CSV here or click to browse'}
            <input
              id="csv"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                F(e.target.files?.[0] || null);
                V(null);
                C(false);
                X('');
                N('');
              }}
            />
            <small>CSV format · Maximum 5 MB</small>
          </label>

          <div className="actions">
            <span>✓ Validated before any changes are made</span>
            <button disabled={!file || loading} onClick={previewFile}>
              {loading ? 'Checking…' : 'Validate & preview →'}
            </button>
          </div>
        </section>

        <div className="features">
          <div>
            <b>↻ Smart matching</b>
            <p>Existing products match by SKU. Document IDs stay unchanged.</p>
          </div>
          <div>
            <b>◷ Preview first</b>
            <p>Nothing changes until you confirm an import.</p>
          </div>
          <div>
            <b>✓ Safer updates</b>
            <p>Blank optional cells preserve current values.</p>
          </div>
        </div>

        {error && <div className="error alert">{error}</div>}
        {notice && <div className="success alert">{notice}</div>}

        {preview && (
          <section className="card review">
            <label>VALIDATION COMPLETE</label>
            <h2>Review import changes</h2>
            <p>Check the proposed operations below.</p>

            <div className="metrics">
              <div>
                Total rows
                <strong>{preview.totalRows}</strong>
              </div>
              <div>
                New products
                <strong className="green">{preview.createCount}</strong>
              </div>
              <div>
                Products to update
                <strong className="blue">{preview.updateCount}</strong>
              </div>
            </div>

            <div className="tools">
              <input
                placeholder="Search SKU, product or category…"
                value={search}
                onChange={(e) => S(e.target.value)}
              />
              <select value={filter} onChange={(e) => Q(e.target.value)}>
                <option value="ALL">All operations</option>
                <option value="CREATE">New products</option>
                <option value="UPDATE">Updates</option>
              </select>
            </div>

            <div className="tablebox">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>SKU</th>
                    <th>Product</th>
                    <th>Category</th>
                    <th>CSV price</th>
                    <th>Document ID</th>
                  </tr>
                </thead>
                <tbody>
                  {ops.map((o, i) => (
                    <tr key={o.sku + i}>
                      <td>
                        <i className={o.operation}>{o.operation}</i>
                      </td>
                      <td>{o.sku}</td>
                      <td>{o.name}</td>
                      <td>{o.category}</td>
                      <td>₹{o.price}</td>
                      <td>{o.documentId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="note">
              ⓘ　This is a preview, not a live database diff. Matched product
              IDs are preserved.
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => C(e.target.checked)}
              />
              I reviewed the plan and authorize these changes to the live
              catalogue.
            </label>

            <button
              className="commit"
              disabled={
                !confirm ||
                loading ||
                preview.totalRows !== preview.createCount + preview.updateCount
              }
              onClick={commit}
            >
              {loading
                ? 'Importing…'
                : `Confirm & import ${preview.totalRows} row(s)`}
            </button>

            <p className="subtle">
              Commit revalidates the file and rebuilds the plan against
              Firestore.
            </p>
          </section>
        )}

        <footer className="pagefoot">
          BONMART OPERATIONS · Handle product data with care.
        </footer>
      </main>
    </div>
  );
}