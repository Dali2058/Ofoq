import fs from 'fs';
import { AI, LIMITS } from './config.js';
import { db } from './db.js';
import { webSearch } from './search.js';
import { generateFile } from './files.js';

const strArr = { type: 'array', items: { type: 'string' } };

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'ابحث على الإنترنت عن معلومات حديثة أو أخبار أو أسعار أو أي شيء قد يكون تغيّر. استخدمها قبل الإجابة في أي سؤال عن الحاضر.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'استعلام البحث، قصير ومحدد' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description:
        'أنشئ ملفًا قابلًا للتنزيل للمستخدم. docx/pdf: استخدم title وsections. xlsx: استخدم sheets. pptx: استخدم title وslides. txt/md/csv/code: استخدم content واسم ملف بالامتداد الصحيح. اكتب المحتوى كاملًا وجاهزًا. للعربي فضّل docx لأن PDF العربي تجريبي.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['docx', 'pdf', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'code'] },
          filename: { type: 'string', description: 'اسم الملف مع الامتداد' },
          title: { type: 'string' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: { heading: { type: 'string' }, paragraphs: strArr, bullets: strArr },
            },
          },
          sheets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                columns: strArr,
                rows: { type: 'array', items: strArr },
              },
            },
          },
          slides: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, bullets: strArr, notes: { type: 'string' } },
            },
          },
          content: { type: 'string' },
        },
        required: ['format', 'filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'احفظ معلومة ثابتة ومفيدة عن المستخدم (اسمه، تفضيلاته، مشروعه) لتُستخدم في المحادثات القادمة. لا تحفظ بيانات حساسة مثل كلمات المرور.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
];

function systemPrompt(memories) {
  const today = new Date().toISOString().slice(0, 10);
  let p = `أنت "أفق"، مساعد ذكاء اصطناعي عملي داخل منصة متكاملة. التاريخ اليوم ${today}.
- رُد بنفس لغة المستخدم ولهجته (لو كتب بالمصري رُد بمصري واضح ومهذب).
- للأكواد: اكتبها داخل كتل markdown مع اسم اللغة، وعند التصحيح اشرح سبب الخطأ باختصار ثم الكود المصحح.
- استخدم web_search لأي معلومة حديثة أو متغيرة، واذكر المصادر (الروابط) في الإجابة.
- استخدم create_file لما المستخدم يطلب ملف (Word/PDF/Excel/PowerPoint/نص/كود). اكتب المحتوى كاملًا داخل الأداة، وبعدها قول له بجملة قصيرة إن الملف جاهز ولا تكرر محتواه.
- استخدم remember للمعلومات الثابتة عن المستخدم فقط.
- لو في صورة أو ملف مرفق، حلله بدقة. لو مش متأكد من شيء قله بصراحة بدل ما تخمّن.`;
  if (memories.length) p += '\n\nمعلومات محفوظة عن المستخدم:\n' + memories.map((m) => '- ' + m.text).join('\n');
  return p;
}

async function callModel(messages) {
  if (!AI.key) {
    const e = new Error('no_key');
    e.userMessage = 'مفتاح الذكاء الاصطناعي مش مضبوط على الخادم. أضف AI_API_KEY في ملف .env.';
    throw e;
  }
  let r;
  try {
    r = await fetch(AI.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI.key}` },
      body: JSON.stringify({ model: AI.model, messages, tools: TOOLS, tool_choice: 'auto' }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    console.error('AI request failed:', err.message);
    const e = new Error('network');
    e.userMessage = 'تعذّر الاتصال بمزوّد الذكاء الاصطناعي. جرّب تاني.';
    throw e;
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error('AI error', r.status, body.slice(0, 500));
    const e = new Error('provider_' + r.status);
    e.userMessage =
      r.status === 429
        ? 'الحد المجاني عند مزوّد الذكاء الاصطناعي اتستنفد مؤقتًا. جرّب بعد دقيقة.'
        : r.status === 401 || r.status === 403
        ? 'مفتاح الذكاء الاصطناعي غير صالح. راجع AI_API_KEY.'
        : 'حصل خطأ من مزوّد الذكاء الاصطناعي. جرّب تاني.';
    throw e;
  }
  const data = await r.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) {
    const e = new Error('empty');
    e.userMessage = 'ردّ المزوّد كان فاضي. جرّب تاني.';
    throw e;
  }
  return msg;
}

async function runTool(name, args, ctx) {
  try {
    if (name === 'web_search') {
      ctx.send('status', { text: '🔎 بدوّر على الإنترنت: ' + String(args.query || '').slice(0, 80) });
      return await webSearch(args.query);
    }
    if (name === 'create_file') {
      ctx.send('status', { text: '📄 بجهّز الملف: ' + String(args.filename || '').slice(0, 60) });
      const f = await generateFile(ctx.userId, ctx.chatId, args);
      ctx.files.push(f);
      ctx.send('file', f);
      return `تم إنشاء الملف "${f.name}" وهو متاح للمستخدم للتنزيل.`;
    }
    if (name === 'remember') {
      const text = String(args.text || '').trim().slice(0, 300);
      if (!text) return 'لا يوجد نص للحفظ.';
      const count = db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id=?').get(ctx.userId).c;
      if (count >= LIMITS.maxMemories) return 'الذاكرة ممتلئة.';
      db.prepare('INSERT INTO memories (user_id,text) VALUES (?,?)').run(ctx.userId, text);
      return 'تم الحفظ.';
    }
    return 'أداة غير معروفة.';
  } catch (e) {
    console.error('tool error', name, e);
    return 'فشل تنفيذ الأداة: ' + e.message;
  }
}

// يبني محتوى رسالة المستخدم الحالية (نص + مستندات + صور)
export function buildUserContent(text, docs, images) {
  let full = text;
  for (const d of docs) full += `\n\n--- محتوى الملف المرفق: ${d.name} ---\n${d.text.slice(0, LIMITS.docCharsCurrent)}`;
  if (!images.length) return full;
  return [
    { type: 'text', text: full },
    ...images.map((im) => ({
      type: 'image_url',
      image_url: { url: `data:${im.mime};base64,${fs.readFileSync(im.path).toString('base64')}` },
    })),
  ];
}

export function historyToMessages(rows) {
  return rows.map((m) => {
    let meta = {};
    try { meta = JSON.parse(m.meta); } catch {}
    let content = m.content;
    if (m.role === 'user') {
      for (const d of meta.docs || []) content += `\n\n--- ملف مرفق سابقًا: ${d.name} ---\n${String(d.text).slice(0, LIMITS.docCharsHistory)}`;
      for (const n of meta.imageNames || []) content += `\n[صورة مرفقة سابقًا: ${n}]`;
    } else if ((meta.files || []).length) {
      content += '\n[ملفات تم إنشاؤها: ' + meta.files.map((f) => f.name).join('، ') + ']';
    }
    return { role: m.role, content };
  });
}

export async function runAgent({ userId, chatId, history, userContent, memories, send }) {
  const messages = [{ role: 'system', content: systemPrompt(memories) }, ...history, { role: 'user', content: userContent }];
  const ctx = { userId, chatId, send, files: [] };
  for (let round = 0; round < LIMITS.maxToolRounds; round++) {
    const msg = await callModel(messages);
    const calls = msg.tool_calls || [];
    if (!calls.length) return { text: (msg.content || '').trim() || '…', files: ctx.files };
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
      const result = await runTool(c.function.name, args, ctx);
      messages.push({ role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 8000) });
    }
  }
  // وصلنا للحد الأقصى من جولات الأدوات: اطلب إجابة نهائية بدون أدوات
  messages.push({ role: 'user', content: 'لخّص ما تم وأعطني الإجابة النهائية الآن.' });
  const final = await callModel(messages);
  return { text: (final.content || '').trim() || '…', files: ctx.files };
}
