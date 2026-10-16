import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import PptxGenJS from 'pptxgenjs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { db } from './db.js';

const AR = /[؀-ۿ]/;
const isRtl = (s) => AR.test(String(s || ''));

export const UPLOAD_EXT = new Set([
  'pdf', 'docx', 'xlsx', 'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'ts', 'py', 'java',
  'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sql', 'sh', 'png', 'jpg', 'jpeg', 'webp', 'gif',
]);
export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const TEXT_OUT_EXT = new Set(['txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sql', 'sh']);

export const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};
const mimeOf = (ext) => MIME[ext] || 'text/plain; charset=utf-8';

// ---------- قراءة الملفات المرفوعة ----------
export async function extractText(filePath, name) {
  const ext = extOf(name);
  if (ext === 'pdf') {
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const data = await pdfParse(fs.readFileSync(filePath));
    return data.text || '';
  }
  if (ext === 'docx') {
    const r = await mammoth.extractRawText({ path: filePath });
    return r.value || '';
  }
  if (ext === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const parts = [];
    wb.eachSheet((ws) => {
      parts.push(`## ${ws.name}`);
      ws.eachRow((row) => {
        const vals = row.values.slice(1).map((v) => (v && typeof v === 'object' ? v.result ?? v.text ?? '' : v ?? ''));
        parts.push(vals.join(' | '));
      });
    });
    return parts.join('\n');
  }
  return fs.readFileSync(filePath, 'utf8');
}

// ---------- مولّدات الملفات ----------
function safeName(name, ext) {
  let base = String(name || 'file').replace(/\.[^.]*$/, '');
  base = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 80) || 'file';
  return `${base}.${ext}`;
}

const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (x == null ? '' : String(x));

async function makeDocx(spec) {
  const rtl = isRtl(JSON.stringify(spec));
  const run = (text, extra = {}) => new TextRun({ text: str(text), rightToLeft: rtl, ...extra });
  const children = [];
  if (spec.title) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, bidirectional: rtl, children: [run(spec.title, { bold: true })] }));
  }
  for (const s of arr(spec.sections)) {
    if (s.heading) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, bidirectional: rtl, children: [run(s.heading, { bold: true })] }));
    for (const p of arr(s.paragraphs)) children.push(new Paragraph({ bidirectional: rtl, spacing: { after: 160 }, children: [run(p)] }));
    for (const b of arr(s.bullets)) children.push(new Paragraph({ bidirectional: rtl, bullet: { level: 0 }, children: [run(b)] }));
  }
  if (!children.length && spec.content) {
    for (const line of str(spec.content).split('\n')) children.push(new Paragraph({ bidirectional: rtl, children: [run(line)] }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

async function makeXlsx(spec) {
  const wb = new ExcelJS.Workbook();
  const sheets = arr(spec.sheets).length ? arr(spec.sheets) : [{ name: 'Sheet1', columns: [], rows: [] }];
  for (const [i, sh] of sheets.entries()) {
    const ws = wb.addWorksheet(str(sh.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, '_').slice(0, 31));
    const cols = arr(sh.columns).map(str);
    const rows = arr(sh.rows).map((r) =>
      arr(r).map((v) => {
        const s = str(v);
        if (s.startsWith('=')) return { formula: s.slice(1) };
        if (s.trim() !== '' && /^-?\d+(\.\d+)?$/.test(s.trim())) return Number(s);
        return s;
      })
    );
    if (cols.length) {
      const h = ws.addRow(cols);
      h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
    }
    rows.forEach((r) => ws.addRow(r));
    ws.columns.forEach((c) => {
      let max = 10;
      c.eachCell({ includeEmpty: false }, (cell) => {
        const len = str(cell.value?.result ?? cell.value).length;
        if (len > max) max = Math.min(len, 60);
      });
      c.width = max + 2;
    });
    if (isRtl(JSON.stringify(sh))) ws.views = [{ rightToLeft: true }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function makePptx(spec) {
  const rtl = isRtl(JSON.stringify(spec));
  const p = new PptxGenJS();
  p.layout = 'LAYOUT_WIDE';
  const align = rtl ? 'right' : 'left';
  const slides = arr(spec.slides);
  if (spec.title) {
    const s = p.addSlide();
    s.background = { color: '0B1B2B' };
    s.addText(str(spec.title), { x: 0.8, y: 2.4, w: 11.7, h: 1.6, fontSize: 40, bold: true, color: 'FFFFFF', align, rtlMode: rtl });
    s.addShape(p.ShapeType.rect, { x: rtl ? 11.2 : 0.8, y: 4.2, w: 1.3, h: 0.08, fill: { color: 'F5B544' } });
  }
  for (const sl of slides) {
    const s = p.addSlide();
    s.background = { color: '0B1B2B' };
    s.addText(str(sl.title), { x: 0.8, y: 0.45, w: 11.7, h: 1, fontSize: 30, bold: true, color: 'F5B544', align, rtlMode: rtl });
    const bullets = arr(sl.bullets).map((b) => ({ text: str(b), options: { bullet: true, breakLine: true } }));
    if (bullets.length)
      s.addText(bullets, { x: 0.8, y: 1.7, w: 11.7, h: 5, fontSize: 20, color: 'E6EDF3', valign: 'top', paraSpaceAfter: 10, align, rtlMode: rtl });
    if (sl.notes) s.addNotes(str(sl.notes));
  }
  return p.write({ outputType: 'nodebuffer' });
}

function makePdf(spec) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, info: { Title: str(spec.title || 'Document') } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // للعربي: ضع خط يدعم العربية في fonts/arabic.ttf (دعم الـ RTL في PDF تجريبي)
    const fontPath = 'fonts/arabic.ttf';
    const hasFont = fs.existsSync(fontPath);
    const rtl = isRtl(JSON.stringify(spec));
    if (hasFont) doc.registerFont('main', fontPath);
    const f = (bold) => (hasFont ? 'main' : bold ? 'Helvetica-Bold' : 'Helvetica');
    const align = rtl && hasFont ? 'right' : 'left';
    if (spec.title) doc.font(f(true)).fontSize(22).text(str(spec.title), { align }).moveDown();
    for (const s of arr(spec.sections)) {
      if (s.heading) doc.font(f(true)).fontSize(15).text(str(s.heading), { align }).moveDown(0.3);
      for (const p of arr(s.paragraphs)) doc.font(f(false)).fontSize(11.5).text(str(p), { align, lineGap: 3 }).moveDown(0.6);
      for (const b of arr(s.bullets)) doc.font(f(false)).fontSize(11.5).text('•  ' + str(b), { align, lineGap: 3 });
      doc.moveDown();
    }
    if (!arr(spec.sections).length && spec.content) doc.font(f(false)).fontSize(11.5).text(str(spec.content), { align, lineGap: 3 });
    doc.end();
  });
}

export async function generateFile(userId, chatId, spec) {
  const format = str(spec.format).toLowerCase();
  let buffer;
  let ext = format;
  if (format === 'docx') buffer = await makeDocx(spec);
  else if (format === 'xlsx') buffer = await makeXlsx(spec);
  else if (format === 'pptx') buffer = await makePptx(spec);
  else if (format === 'pdf') buffer = await makePdf(spec);
  else {
    // نصوص وأكواد: الامتداد من اسم الملف
    ext = extOf(spec.filename) || (format === 'code' ? 'txt' : format);
    if (!TEXT_OUT_EXT.has(ext)) ext = 'txt';
    buffer = Buffer.from(str(spec.content), 'utf8');
  }
  const name = safeName(spec.filename || spec.title, ext);
  const id = crypto.randomBytes(12).toString('hex');
  const dir = path.join('data', 'generated', String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, id + '.' + ext);
  fs.writeFileSync(filePath, buffer);
  db.prepare('INSERT INTO files (id,user_id,chat_id,kind,name,path,mime,size) VALUES (?,?,?,?,?,?,?,?)').run(
    id, userId, chatId, 'generated', name, filePath, mimeOf(ext), buffer.length
  );
  return { id, name, format: ext, size: buffer.length };
}
