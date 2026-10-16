// تشغيل: npm run check-ai
// بيجرّب مفتاح المزوّد المضبوط في .env بطلب حقيقي، وبيطبع النتيجة بدون عرض المفتاح.
import 'dotenv/config';
import { AI } from '../server/config.js';

if (!AI.key) {
  console.error('✗ AI_API_KEY فاضي في .env');
  process.exit(1);
}
console.log(`المزوّد: ${AI.baseUrl}\nالموديل: ${AI.model}\nالمفتاح: ${AI.key.slice(0, 4)}…${AI.key.slice(-4)}`);

const t0 = Date.now();
try {
  const r = await fetch(AI.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI.key}` },
    body: JSON.stringify({ model: AI.model, messages: [{ role: 'user', content: 'قول مرحبا بجملة واحدة بالمصري' }], max_tokens: 80 }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await r.text();
  if (!r.ok) {
    console.error(`✗ فشل (HTTP ${r.status}):`, body.slice(0, 600));
    if (r.status === 401 || r.status === 403) console.error('→ المفتاح غير صالح أو الحساب مش مفعّل.');
    if (r.status === 400 || r.status === 404) console.error('→ غالبًا اسم الموديل غلط. راجع قائمة الموديلات عند المزوّد وعدّل AI_MODEL.');
    if (r.status === 429) console.error('→ الحد المجاني أو الرصيد خلص.');
    process.exit(1);
  }
  const data = JSON.parse(body);
  console.log(`✓ شغّال (${Date.now() - t0}ms). الرد:`, data.choices?.[0]?.message?.content);
} catch (e) {
  console.error('✗ تعذّر الاتصال:', e.message);
  process.exit(1);
}
