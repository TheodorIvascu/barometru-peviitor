"use strict";
/**
 * Romanian fiscal identifier (CIF / CUI).
 *
 * The peviitor_core contract says Company.id is the exact CIF: 8 digits, no
 * "RO" prefix. Job.cif should match it. For comparison we fold both sides to
 * a bare digit string with leading zeros removed; for validation we check the
 * official checksum (key 753217532).
 */

/** "RO 08119423" -> "8119423"; used only for comparison, never for display */
function cifKey(raw) {
  return String(raw == null ? "" : raw).replace(/^\s*ro/i, "").replace(/\D/g, "").replace(/^0+/, "");
}

function cifChecksumOk(raw) {
  const s = cifKey(raw);
  if (!/^\d{2,10}$/.test(s)) return false;
  const KEY = "753217532";
  const body = s.slice(0, -1).padStart(9, "0");
  const check = Number(s.slice(-1));
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * Number(KEY[i]);
  const r = (sum * 10) % 11;
  return (r === 10 ? 0 : r) === check;
}

/** the literal string as stored, exactly 8 digits, nothing else */
function cifIsContractShape(raw) {
  return /^\d{8}$/.test(String(raw == null ? "" : raw));
}

function cifHasRoPrefix(raw) {
  return /^\s*ro/i.test(String(raw == null ? "" : raw));
}

module.exports = { cifKey, cifChecksumOk, cifIsContractShape, cifHasRoPrefix };
