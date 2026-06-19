const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || 'buyerai-change-this-secret';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const PLAN_LIMITS = { free: 5, basic: 20, pro: 50, unlimited: 9999 };
const PLAN_NAMES = { free: 'Бесплатный', basic: 'Базовый', pro: 'Про', unlimited: 'Безлимит' };

// ── Init Database ──────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id        SERIAL PRIMARY KEY,
      email     TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan      TEXT DEFAULT 'free',
      daily_count INTEGER DEFAULT 0,
      last_reset  DATE DEFAULT CURRENT_DATE,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Database ready');
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '25mb' }));
app.use(express.static(__dirname));

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Сессия истекла — войди снова' });
  }
}

async function resetIfNewDay(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  const today = new Date().toISOString().split('T')[0];
  const lastReset = user.last_reset ? new Date(user.last_reset).toISOString().split('T')[0] : '';
  if (lastReset !== today) {
    await pool.query('UPDATE users SET daily_count = 0, last_reset = CURRENT_DATE WHERE id = $1', [userId]);
    user.daily_count = 0;
  }
  return user;
}

// ── Auth Routes ────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    if (!email.includes('@')) return res.status(400).json({ error: 'Неверный формат email' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, plan',
      [email.toLowerCase().trim(), hash]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { email: user.email, plan: user.plan, daily_count: 0, limit: PLAN_LIMITS[user.plan] } });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Этот email уже зарегистрирован' });
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email?.toLowerCase().trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    const fresh = await resetIfNewDay(user.id);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { email: user.email, plan: user.plan, daily_count: fresh.daily_count, limit: PLAN_LIMITS[user.plan] || 5 } });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await resetIfNewDay(req.user.id);
    res.json({ email: user.email, plan: user.plan, plan_name: PLAN_NAMES[user.plan], daily_count: user.daily_count, limit: PLAN_LIMITS[user.plan] || 5 });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Analyze Route ──────────────────────────────────────────────────────────────
app.post('/api/analyze', requireAuth, async (req, res) => {
  try {
    const user = await resetIfNewDay(req.user.id);
    const limit = PLAN_LIMITS[user.plan] || 5;

    if (user.daily_count >= limit) {
      return res.status(429).json({
        error: `Лимит исчерпан: ${limit} запросов/день на тарифе «${PLAN_NAMES[user.plan]}». Напиши @VIKTOR_CN1 в Telegram для апгрейда.`,
        limitReached: true
      });
    }

    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: 'Нет изображения' });
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API ключ не настроен на сервере' });

    const prompt = `Analyze this product image for a China B2B sourcing app. Return ONLY a raw JSON object (no markdown, no backticks, just valid JSON):
{"productName":"Russian name 2-4 words","productNameCN":"Chinese characters name","category":"category in Russian","material":"main material in Russian","style":"design style in Russian e.g. Японский минимализм","application":"use cases in Russian max 3 separated by · symbol","confidence":95,"keywords":{"cn":["keyword1","keyword2","keyword3","keyword4"],"en":["keyword1","keyword2","keyword3"]},"suppliers":[{"name":"Realistic Chinese manufacturer company name","type":"manufacturer","rating":4.8,"reviews":3214,"monthlySales":"42,800","priceMin":8.5,"priceMax":15.8,"moq":"200 шт","capital":"300万","years":9,"location":"Yiwu, Zhejiang","staff":"50–100","cert":"ISO 9001"},{"name":"Second realistic Chinese manufacturer","type":"manufacturer","rating":4.7,"reviews":1876,"monthlySales":"28,400","priceMin":10.2,"priceMax":18.5,"moq":"100 шт","capital":"500万","years":12,"location":"Ningbo, Zhejiang","staff":"100–200","cert":""},{"name":"Chinese trading company","type":"trader","rating":4.5,"reviews":892,"priceMin":15.0,"priceMax":28.0,"years":4,"location":"Guangzhou, GD"}]}
Use realistic Chinese company names, cities, and pricing appropriate for THIS specific product type.`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } }, { type: 'text', text: prompt }] }] })
    });

    if (!apiRes.ok) {
      const e = await apiRes.json().catch(() => ({}));
      throw new Error(e.error?.message || 'Anthropic API error ' + apiRes.status);
    }

    const apiData = await apiRes.json();
    const txt = apiData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const result = JSON.parse(txt.replace(/```json|```/g, '').trim());

    await pool.query('UPDATE users SET daily_count = daily_count + 1 WHERE id = $1', [user.id]);

    res.json({ ...result, usage: { count: user.daily_count + 1, limit, plan: user.plan } });
  } catch (e) {
    console.error('Analyze error:', e.message);
    res.status(500).json({ error: e.message || 'Ошибка анализа' });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 BuyerAI running on port ${PORT}`));
}).catch(e => {
  console.error('Failed to init DB:', e.message);
  process.exit(1);
});
