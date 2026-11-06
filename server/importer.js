const { parse } = require('csv-parse/sync');
const { db, admin } = require('./firebase');

const REQUIRED = ['sku', 'name', 'price', 'category'];
const OPTIONAL = ['image', 'protext', 'rating', 'unit', 'stock', 'maxOrderQty'];

const clean = (value) => String(value ?? '').trim();

function num(value, field, row, { integer = false, required = false, positive = false } = {}) {
  const raw = clean(value);
  if (!raw && !required) return undefined;
  if (!raw) throw Error(`Row ${row}: ${field} is required`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed)) || (positive && parsed <= 0)) {
    throw Error(`Row ${row}: ${field} must be a ${positive ? 'positive' : 'non-negative'} ${integer ? 'integer' : 'number'}`);
  }
  return parsed;
}

function parsePresetUnits(value, enabled, row) {
  if (enabled === undefined && !clean(value)) return undefined;
  if (enabled === false) return [];
  if (!clean(value)) {
    if (enabled === true) throw Error(`Row ${row}: presetUnits is required when presetUnitsEnabled is TRUE`);
    return undefined;
  }

  let options;
  try {
    options = JSON.parse(value);
  } catch {
    throw Error(`Row ${row}: presetUnits must contain valid JSON`);
  }
  if (!Array.isArray(options) || options.length === 0) {
    throw Error(`Row ${row}: presetUnits must be a non-empty JSON array`);
  }

  const ids = new Set();
  return options.map((option, index) => {
    const id = clean(option?.id);
    const label = clean(option?.label);
    if (!id) throw Error(`Row ${row}: preset option ${index + 1} needs an id`);
    if (ids.has(id)) throw Error(`Row ${row}: duplicate preset option id '${id}'`);
    ids.add(id);
    if (!label) throw Error(`Row ${row}: preset option '${id}' needs a label`);
    const baseQuantity = Number(option?.baseQuantity);
    const price = Number(option?.price);
    if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) {
      throw Error(`Row ${row}: preset option '${id}' baseQuantity must be greater than zero`);
    }
    if (!Number.isFinite(price) || price < 0) {
      throw Error(`Row ${row}: preset option '${id}' price must be zero or greater`);
    }
    return { id, label, baseQuantity, price };
  });
}

function parseRows(buffer) {
  const rows = parse(buffer, {
    columns: (headers) => headers.map((header) => header.trim()),
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });
  if (!rows.length) throw Error('CSV contains no product rows.');

  const headers = Object.keys(rows[0]);
  for (const field of REQUIRED) {
    if (!headers.includes(field)) throw Error(`Missing required CSV column: ${field}`);
  }

  const seen = new Set();
  const valid = [];
  const errors = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    try {
      const product = {};
      for (const field of REQUIRED) {
        product[field] = clean(row[field]);
        if (!product[field]) throw Error(`${field} is required`);
      }

      product.sku = product.sku.toUpperCase();
      if (seen.has(product.sku)) throw Error(`Duplicate SKU in CSV: ${product.sku}`);
      seen.add(product.sku);

      product.price = num(row.price, 'price', rowNumber, { required: true });
      product.rating = num(row.rating, 'rating', rowNumber);
      product.stock = num(row.stock, 'stock', rowNumber, { integer: true });
      product.maxOrderQty = num(row.maxOrderQty, 'maxOrderQty', rowNumber, { integer: true });
      for (const field of ['image', 'protext', 'unit']) product[field] = clean(row[field]);

      const enabledText = clean(row.presetUnitsEnabled).toLowerCase();
      if (enabledText && !['true', 'false'].includes(enabledText)) {
        throw Error('presetUnitsEnabled must be TRUE or FALSE');
      }
      product.presetUnitsEnabled = enabledText ? enabledText === 'true' : undefined;
      product.presetUnits = parsePresetUnits(row.presetUnits, product.presetUnitsEnabled, rowNumber);
      if (product.presetUnits !== undefined && product.presetUnitsEnabled === undefined) {
        product.presetUnitsEnabled = true;
      }

      if (product.presetUnitsEnabled === true && !product.unit) {
        throw Error('unit (the base unit, such as kg or g) is required when presets are enabled');
      }
      valid.push({ rowNumber, product });
    } catch (error) {
      errors.push(`Row ${rowNumber}: ${error.message}`);
    }
  });

  if (errors.length) throw Error('CSV validation failed:\n' + errors.join('\n'));
  return { rows, valid };
}

async function buildPlan(buffer) {
  const { rows, valid } = parseRows(buffer);
  const [productsSnapshot, categoriesSnapshot] = await Promise.all([
    db.collection('products').get(),
    db.collection('categories').get(),
  ]);

  const bySku = new Map();
  for (const document of productsSnapshot.docs) {
    for (const key of [document.data().sku, document.id].filter(Boolean).map((value) => String(value).trim().toUpperCase())) {
      if (bySku.has(key) && bySku.get(key).id !== document.id) {
        throw Error(`Ambiguous SKU/document ID '${key}'.`);
      }
      bySku.set(key, document);
    }
  }

  const categories = new Set();
  for (const document of categoriesSnapshot.docs) {
    const data = document.data();
    for (const value of [data.name, data.category, data.title]) {
      if (typeof value === 'string' && value.trim()) categories.add(value.trim().toLowerCase());
    }
  }

  const plan = [];
  const errors = [];
  for (const { rowNumber, product } of valid) {
    if (categories.size && !categories.has(product.category.toLowerCase())) {
      errors.push(`Row ${rowNumber}: category '${product.category}' was not found.`);
      continue;
    }

    const existing = bySku.get(product.sku);
    const isNew = !existing;
    if (isNew && (!product.image || product.stock === undefined || product.rating === undefined || product.maxOrderQty === undefined || !product.unit)) {
      errors.push(`Row ${rowNumber}: new products require image, stock, rating, unit and maxOrderQty.`);
      continue;
    }
    if (isNew && product.presetUnitsEnabled === true && !product.presetUnits?.length) {
      errors.push(`Row ${rowNumber}: new products with presets require at least one preset option.`);
      continue;
    }

    const ref = existing ? existing.ref : db.collection('products').doc();
    const data = {
      sku: product.sku,
      name: product.name,
      price: product.price,
      category: product.category,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isNew) {
      Object.assign(data, {
        image: product.image,
        protext: product.protext || '',
        rating: product.rating,
        unit: product.unit,
        stock: product.stock,
        maxOrderQty: product.maxOrderQty,
        presetUnitsEnabled: product.presetUnitsEnabled === true,
        presetUnits: product.presetUnits || [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      for (const field of OPTIONAL) {
        if (product[field] !== undefined && product[field] !== '') data[field] = product[field];
      }
      // Blank preset columns preserve the current configuration. FALSE explicitly clears it.
      if (product.presetUnitsEnabled !== undefined) {
        data.presetUnitsEnabled = product.presetUnitsEnabled;
        if (product.presetUnitsEnabled === false) data.presetUnits = [];
      }
      if (product.presetUnits !== undefined) data.presetUnits = product.presetUnits;
    }

    plan.push({
      sku: product.sku,
      name: product.name,
      category: product.category,
      price: product.price,
      presetUnitsEnabled: data.presetUnitsEnabled ?? existing?.data()?.presetUnitsEnabled ?? false,
      presetUnits: data.presetUnits ?? existing?.data()?.presetUnits ?? [],
      operation: isNew ? 'CREATE' : 'UPDATE',
      documentId: ref.id,
      ref,
      data,
    });
  }

  if (errors.length) throw Error('Import validation failed:\n' + errors.join('\n'));

  return {
    totalRows: rows.length,
    createCount: plan.filter((item) => item.operation === 'CREATE').length,
    updateCount: plan.filter((item) => item.operation === 'UPDATE').length,
    operations: plan.map(({ sku, name, category, price, presetUnitsEnabled, presetUnits, operation, documentId }) => ({
      sku, name, category, price, presetUnitsEnabled, presetUnits, operation, documentId,
    })),
    plan,
  };
}

async function commitPlan(plan) {
  for (let index = 0; index < plan.length; index += 400) {
    const batch = db.batch();
    for (const item of plan.slice(index, index + 400)) {
      batch.set(item.ref, item.data, { merge: true });
    }
    await batch.commit();
  }
}

module.exports = { buildPlan, commitPlan };
