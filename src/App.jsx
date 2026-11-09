import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { auth } from './firebase';

const HEADERS = [
  'productId', 'sku', 'name', 'mrp', 'price', 'image', 'protext',
  'category', 'rating', 'unit', 'stock', 'maxOrderQty', 'brandName',
];

const EXAMPLE = {
  productId: '',
  sku: 'EXAMPLE001',
  name: 'Example product',
  mrp: 30,
  price: 25,
  image: 'https://example.com/image.jpg',
  protext: 'Example description',
  category: 'Flour,Suji',
  rating: 0,
  unit: '1 pack',
  stock: 10,
  maxOrderQty: 3,
  brandName: '',
};

function downloadTemplate() {
  const workbook = XLSX.utils.book_new();
  const products = XLSX.utils.json_to_sheet([EXAMPLE], { header: HEADERS });
  products['!cols'] = [
    { wch: 26 }, { wch: 18 }, { wch: 30 }, { wch: 12 }, { wch: 12 },
    { wch: 48 }, { wch: 42 }, { wch: 24 }, { wch: 10 }, { wch: 16 },
    { wch: 12 }, { wch: 16 }, { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(workbook, products, 'Products');

  const instructions = [
    ['BONMART PRODUCT IMPORT TEMPLATE'],
    ['Use the Products sheet for one product per row. Do not rename the sheet or column headers.'],
    ['Required for every row: name, mrp, price, category. MRP must be greater than or equal to selling price.'],
    ['New product: SKU and image are also required. Leave productId blank.'],
    ['Update existing product: provide productId (Firestore document ID) or an existing SKU. productId is the safest match.'],
    ['Category must exactly match an existing category in the BonMart admin app.'],
    ['brandName must exactly match an active brand in Manage Brands. Leave blank to preserve an existing brand.'],
    ['To remove a brand from an existing product, enter __CLEAR__ in brandName.'],
    ['Blank optional cells preserve existing values on updates. For new products, blank optional values use admin defaults.'],
    ['Supported optional fields: image, protext, rating (0–5), unit, stock (whole number), maxOrderQty (whole number).'],
    ['Do not edit groupId or productGroups here. Product group membership is managed in the Admin app and is preserved by imports.'],
    ['Do not change the Products sheet name or the header row. Remove the example row before importing real data.'],
  ];
  const guide = XLSX.utils.aoa_to_sheet(instructions);
  guide['!cols'] = [{ wch: 125 }];
  XLSX.utils.book_append_sheet(workbook, guide, 'Instructions');

  const fields = [
    ['Column', 'Required', 'Meaning'],
    ['productId', 'For updates (or SKU)', 'Existing Firestore products document ID. Preferred update key.'],
    ['sku', 'For new products', 'Unique SKU. Existing SKU can also identify an update.'],
    ['name', 'Yes', 'Product name shown in the catalogue.'],
    ['mrp', 'Yes', 'Maximum retail price. Must be >= price.'],
    ['price', 'Yes', 'Selling price used by the customer app.'],
    ['image', 'New products', 'Public/downloadable product image URL.'],
    ['protext', 'No', 'Product description text.'],
    ['category', 'Yes', 'Existing category name, not category document ID.'],
    ['rating', 'No', 'Numeric rating from 0 to 5.'],
    ['unit', 'No', 'Pack size / measurement, e.g. 500 g, 1 kg, 1 litre.'],
    ['stock', 'No', 'Shared stock quantity; whole number.'],
    ['maxOrderQty', 'No', 'Maximum quantity per customer; 0 means no limit.'],
    ['brandName', 'No', 'Exact active brand name. Resolves to the brands collection document ID.'],
  ];
  const fieldSheet = XLSX.utils.aoa_to_sheet(fields);
  fieldSheet['!cols'] = [{ wch: 18 }, { wch: 25 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(workbook, fieldSheet, 'Field Guide');
  XLSX.writeFile(workbook, 'bonmart-product-import-template.xlsx');
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
    if (!file) throw Error('Choose a CSV or Excel file first.');
    const fd = new FormData();
    fd.append('file', file);
    Object.entries(extra).forEach(([k, v]) => fd.append(k, String(v)));

    const currentUser = auth.currentUser;
    if (!currentUser) throw Error('Your session has expired. Please sign in again.');

    const token = await currentUser.getIdToken();
    const response = await fetch('/api/' + endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: fd,
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Request failed');
    return data;
  }

  async function login(event) {
    event.preventDefault();
    L(true);
    X('');
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      P('');
    } catch (error) {
      X(error.code === 'auth/invalid-credential' ? 'Email or password is incorrect.' : error.message);
    } finally {
      L(false);
    }
  }

  async function previewFile() {
    L(true); X(''); N(''); V(null); C(false);
    try {
      V(await api('preview'));
      N('Preview ready. No Firestore changes made.');
    } catch (error) {
      X(error.message);
    } finally {
      L(false);
    }
  }

  async function commit() {
    if (!preview) return;
    L(true); X(''); N('');
    try {
      const result = await api('commit', {
        confirm: 'IMPORT',
        sessionId: preview.sessionId,
        digest: preview.digest,
        planDigest: preview.planDigest,
        totalRows: preview.totalRows,
        createCount: preview.createCount,
        updateCount: preview.updateCount,
      });
      N(result.message);
      V(null); F(null); C(false);
      const input = document.getElementById('catalogue-file');
      if (input) input.value = '';
    } catch (error) {
      X(error.message);
    } finally {
      L(false);
    }
  }

  const ops = useMemo(
    () => preview?.operations?.filter((operation) =>
      (filter === 'ALL' || operation.operation === filter) &&
      `${operation.sku} ${operation.name} ${operation.category} ${operation.documentId}`
        .toLowerCase().includes(search.toLowerCase())
    ) || [],
    [preview, filter, search]
  );

  if (!ready) return <div className="loading">Loading secure workspace…</div>;

  if (!user) {
    return (
      <main className="login">
        <section className="hero">
          <Brand />
          <div>
            <label>PRODUCT OPERATIONS</label>
            <h1>Bulk updates.<br /><em>Less busywork.</em></h1>
            <p>Import product catalogues confidently, review every change, and keep your store data consistent.</p>
          </div>
          <small>SECURE WORKSPACE · FIRESTORE ON SERVER</small>
        </section>
        <form className="loginform" onSubmit={login}>
          <label>WELCOME BACK</label>
          <h2>Sign in to BonMart</h2>
          <p>Use your approved staff account.</p>
          <span>Email address</span>
          <input type="email" value={email} onChange={(event) => E(event.target.value)} required />
          <span>Password</span>
          <input type="password" value={password} onChange={(event) => P(event.target.value)} required />
          {error && <div className="error">{error}</div>}
          <button disabled={loading}>{loading ? 'Signing in…' : 'Sign in securely →'}</button>
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
        <footer>● Protected session<br />　CSV · Excel · Firestore</footer>
      </aside>
      <main>
        <header>
          <div><small>WORKSPACE / CATALOGUE</small><h1>Bulk product manager</h1></div>
          <div>{user.email}{' '}<button className="quiet" onClick={() => signOut(auth)}>Sign out</button></div>
        </header>

        <section className="intro">
          <div>
            <h2>Import your product catalogue</h2>
            <p>Upload an Excel workbook or CSV, review proposed changes, then import when everything looks right.</p>
          </div>
          <button className="secondary" onClick={downloadTemplate}>↓ Download Excel template</button>
        </section>

        <div className="steps"><b>1　Upload</b> ─── <b className={preview ? 'active' : ''}>2　Review</b> ─── <b>3　Import</b></div>

        <section className="card">
          <h3>↑　Upload product file</h3>
          <p>Use the BonMart Excel template. CSV files are also supported.</p>
          <label className="drop">
            {file ? file.name : 'Drop your Excel or CSV file here or click to browse'}
            <input
              id="catalogue-file"
              type="file"
              accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
              onChange={(event) => {
                F(event.target.files?.[0] || null);
                V(null); C(false); X(''); N('');
              }}
            />
            <small>Excel (.xlsx) or CSV · Maximum 5 MB</small>
          </label>
          <div className="actions">
            <span>✓ Validated before any changes are made</span>
            <button disabled={!file || loading} onClick={previewFile}>{loading ? 'Checking…' : 'Validate & preview →'}</button>
          </div>
        </section>

        <div className="features">
          <div><b>↻ Smart matching</b><p>Updates match by product document ID first, then SKU. Existing document IDs stay unchanged.</p></div>
          <div><b>◷ Preview first</b><p>Nothing changes until you confirm an import.</p></div>
          <div><b>✓ Safer updates</b><p>Blank optional cells preserve existing values. Group membership is retained.</p></div>
        </div>

        {error && <div className="error alert">{error}</div>}
        {notice && <div className="success alert">{notice}</div>}

        {preview && (
          <section className="card review">
            <label>VALIDATION COMPLETE</label>
            <h2>Review import changes</h2>
            <p>Check the proposed operations below.</p>
            <div className="metrics">
              <div>Total rows<strong>{preview.totalRows}</strong></div>
              <div>New products<strong className="green">{preview.createCount}</strong></div>
              <div>Products to update<strong className="blue">{preview.updateCount}</strong></div>
            </div>
            <div className="tools">
              <input placeholder="Search SKU, product, category or ID…" value={search} onChange={(event) => S(event.target.value)} />
              <select value={filter} onChange={(event) => Q(event.target.value)}>
                <option value="ALL">All operations</option>
                <option value="CREATE">New products</option>
                <option value="UPDATE">Updates</option>
              </select>
            </div>
            <div className="tablebox">
              <table>
                <thead><tr><th>Action</th><th>SKU</th><th>Product</th><th>Category</th><th>MRP</th><th>Selling price</th><th>Brand</th><th>Document ID</th></tr></thead>
                <tbody>
                  {ops.map((operation, index) => (
                    <tr key={operation.documentId + index}>
                      <td><i className={operation.operation}>{operation.operation}</i></td>
                      <td>{operation.sku || '—'}</td>
                      <td>{operation.name}</td>
                      <td>{operation.category}</td>
                      <td>₹{operation.mrp}</td>
                      <td>₹{operation.price}</td>
                      <td>{operation.brand || '—'}</td>
                      <td>{operation.documentId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="note">ⓘ　Preview is generated against the live Firestore catalogue. Product IDs are preserved, and existing groupId fields are not modified.</div>
            <label className="check">
              <input type="checkbox" checked={confirm} onChange={(event) => C(event.target.checked)} />
              I reviewed the plan and authorize these changes to the live catalogue.
            </label>
            <button className="commit" disabled={!confirm || loading || preview.totalRows !== preview.createCount + preview.updateCount} onClick={commit}>
              {loading ? 'Importing…' : `Confirm & import ${preview.totalRows} row(s)`}
            </button>
            <p className="subtle">This preview is valid for 30 minutes. Commit revalidates the file and catalogue using the same server-reserved product IDs.</p>
          </section>
        )}
        <footer className="pagefoot">BONMART OPERATIONS · Handle product data with care.</footer>
      </main>
    </div>
  );
}
