import 'dotenv/config';

export const PORT = Number(process.env.PORT) || 3000;
export const IS_PROD = process.env.NODE_ENV === 'production';

export const AI = {
  key: process.env.AI_API_KEY || '',
  baseUrl: (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, ''),
  model: process.env.AI_MODEL || 'gemini-2.5-flash',
};

// خطط الاستخدام: عدد الرسائل المسموح يوميًا
export const PLANS = {
  free: { label: 'مجاني', daily: 20 },
  pro: { label: 'احترافي', daily: 200 },
  max: { label: 'أقصى', daily: 1000 },
};

export const LIMITS = {
  historyMessages: 30,
  docCharsCurrent: 40000,
  docCharsHistory: 10000,
  maxMemories: 50,
  maxToolRounds: 5,
};
