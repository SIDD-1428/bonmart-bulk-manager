const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const { db, admin } = require('./firebase');

const REQUIRED = ['name', 'mrp', 'price', 'category'];
const OPTIONAL = ['sku', 'image', 'protext', 'rating', 'unit', 'stock', 'maxOrderQty', 'brandName'];
const CLEAR = '__CLEAR__';
const clean = (value) => String(value ?? '').trim();
const normalized = (value) => clean(value).toLowerCase();

function number(value, field, row, { integer = false, required = false } = {}) {
  const raw = clean(value);
  if (!raw && !required) return undefined;
  if (!raw && required) throw new Error(`Row ${row}: ${field} is required.`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`Row ${row}: ${field} must be a non-negative ${integer ? 'integer' : 'number'}.`);
  }
  return parsed;
}

function readRows(buffer, filename = 'products.csv') {
  const isExcel = /\.xlsx?$/i.test(filename);
  if (!isExcel) {
    return parse(buffer, {
      columns: (headers) => headers.map((header) => clean(header)),
      skip_empty_lines: true,
      bom: true,
      trim: true,
    });
  }

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames.find((name) => normalized(name) === 'products');
  if (!sheetName) throw new Error('Excel workbook must contain a sheet named "Products".');
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: '',
    raw: false,
    blankrows: false,
  });
}

function parseRows(buffer, filename) {
  const rows = readRows(buffer, filename);
  if (!rows.length) throw new Error('The Products sheet contains no product rows.');
  const headers = Object.keys(rows[0]).map(clean);
  for (const field of REQUIRED) {
    if (!headers.includes(field)) throw new Error(`Missing required column in Products sheet: ${field}`);
  }

  const seenSkus = new Set();
  const valid = [];
  const errors = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    try {
      const product = {};
      for (const field of REQUIRED) {
        product[field] = clean(row[field]);
        if (!product[field]) throw new Error(`${field} is required.`);
      }
      product.productId = clean(row.productId);
      product.sku = clean(row.sku).toUpperCase();
      if (product.sku) {
        if (seenSkus.has(product.sku)) throw new Error(`Duplicate SKU in file: ${product.sku}.`);
        seenSkus.add(product.sku);
      }

      product.mrp = number(row.mrp, 'mrp', rowNumber, { required: true });
      product.price = number(row.price, 'price', rowNumber, { required: true });
      if (product.mrp < product.price) throw new Error('MRP must be greater than or equal to selling price.');
      product.rating = number(row.rating, 'rating', rowNumber);
      if (product.rating !== undefined && product.rating > 5) throw new Error('rating must be between 0 and 5.');
      product.stock = number(row.stock, 'stock', rowNumber, { integer: true });
      product.maxOrderQty = number(row.maxOrderQty, 'maxOrderQty', rowNumber, { integer: true });

      for (const field of ['image', 'protext', 'unit', 'brandName']) product[field] = clean(row[field]);
      if (product.brandName.toUpperCase() === CLEAR) product.brandName = CLEAR;
      valid.push({ rowNumber, product });
    } catch (error) {
      errors.push(`Row ${rowNumber}: ${error.message}`);
    }
  });

  if (errors.length) throw new Error('Product sheet validation failed:\n' + errors.join('\n'));
  return { rows, valid };
}

async function buildPlan(buffer, filename = 'products.csv') {
  const { rows, valid } = parseRows(buffer, filename);
  const [productSnapshot, categorySnapshot, brandSnapshot] = await Promise.all([
    db.collection('products').get(),
    db.collection('categories').get(),
    db.collection('brands').get(),
  ]);

  const bySku = new Map();
  const byId = new Map();
  for (const document of productSnapshot.docs) {
    const data = document.data();
    byId.set(document.id, document);
    const sku = clean(data.sku).toUpperCase();
    if (sku) {
      if (bySku.has(sku) && bySku.get(sku).id !== document.id) {
        throw new Error(`Ambiguous SKU "${sku}" exists on multiple products.`);
      }
      bySku.set(sku, document);
    }
  }

  const categories = new Map();
  for (const document of categorySnapshot.docs) {
    const data = document.data();
    for (const value of [data.name, data.category, data.title]) {
      if (typeof value === 'string' && value.trim()) categories.set(normalized(value), value.trim());
    }
  }

  const brandsByName = new Map();
  for (const document of brandSnapshot.docs) {
    const data = document.data();
    if (data.name && data.isActive !== false) brandsByName.set(normalized(data.name), { id: document.id, name: data.name });
  }

  const plan = [];
  const errors = [];

  for (const { rowNumber, product } of valid) {
    const category = categories.get(normalized(product.category));
    if (!category) {
      errors.push(`Row ${rowNumber}: category "${product.category}" was not found in the BonMart category catalogue.`);
      continue;
    }

    const skuMatch = product.sku ? bySku.get(product.sku) : null;
const idMatch = product.productId ? byId.get(product.productId) : null;

// If both identifiers match different existing products, reject the row.
if (skuMatch && idMatch && skuMatch.id !== idMatch.id) {
  errors.push(`Row ${rowNumber}: productId and SKU point to different products.`);
  continue;
}

// Prefer an existing document ID match, then an existing SKU match.
// An unknown productId is allowed for a new product.
const existing = idMatch || skuMatch;



    const isNew = !existing;
    if (isNew && !product.sku) {
      errors.push(`Row ${rowNumber}: SKU is required for a new product. For updates, provide productId or an existing SKU.`);
      continue;
    }
    if (isNew && !product.image) {
      errors.push(`Row ${rowNumber}: image is required for a new product.`);
      continue;
    }

    let brandId;
    if (product.brandName && product.brandName !== CLEAR) {
      const brand = brandsByName.get(normalized(product.brandName));
      if (!brand) {
        errors.push(`Row ${rowNumber}: active brand "${product.brandName}" was not found. Use the exact brand name from Manage Brands.`);
        continue;
      }
      brandId = brand.id;
    }

const ref = existing
  ? existing.ref
  : product.productId
    ? db.collection('products').doc(product.productId)
    : db.collection('products').doc();    const oldData = existing ? existing.data() : {};
    const data = {
      name: product.name,
      mrp: product.mrp,
      price: product.price,
      category,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (product.sku) data.sku = product.sku;
    if (isNew) {
      Object.assign(data, {
        image: product.image,
        protext: product.protext || '',
        rating: product.rating ?? 0,
        unit: product.unit || '',
        stock: product.stock ?? 0,
        maxOrderQty: product.maxOrderQty ?? 0,
        brandId: brandId || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      for (const field of ['image', 'protext', 'rating', 'unit', 'stock', 'maxOrderQty']) {
        if (product[field] !== undefined && product[field] !== '') data[field] = product[field];
      }
      if (product.brandName === CLEAR) data.brandId = null;
      else if (brandId) data.brandId = brandId;
      else if (oldData.brandId !== undefined) data.brandId = oldData.brandId;
    }

    plan.push({
      sku: product.sku || clean(oldData.sku) || '',
      name: product.name,
      category,
      mrp: product.mrp,
      price: product.price,
      brand: product.brandName === CLEAR ? 'Clear brand' : (product.brandName || ''),
      operation: isNew ? 'CREATE' : 'UPDATE',
      documentId: ref.id,
      data,
      ref,
    });
  }

  if (errors.length) throw new Error('Import validation failed:\n' + errors.join('\n'));

  return {
    totalRows: rows.length,
    createCount: plan.filter((item) => item.operation === 'CREATE').length,
    updateCount: plan.filter((item) => item.operation === 'UPDATE').length,
    operations: plan.map(({ sku, name, category, mrp, price, brand, operation, documentId }) => ({
      sku, name, category, mrp, price, brand, operation, documentId,
    })),
    plan,
  };
}

async function commitPlan(plan) {
  for (let index = 0; index < plan.length; index += 400) {
    const batch = db.batch();
    for (const item of plan.slice(index, index + 400)) {
      // merge:true intentionally preserves admin-managed fields such as groupId.
      batch.set(item.ref, item.data, { merge: true });
    }
    await batch.commit();
  }
}

module.exports = { buildPlan, commitPlan };
