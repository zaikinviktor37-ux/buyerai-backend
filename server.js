const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
const PRO_PLANS = ['pro', 'unlimited'];
// TESTING MODE: market-fit analysis open to everyone right now so Viktor and beta
// testers can try it without manual plan upgrades. Flip to false to re-enable Pro gating.
const MARKET_FIT_OPEN_FOR_ALL = true;
// TESTING MODE: daily photo-analysis limit disabled for now during testing.
// Flip to false to re-enable the per-plan daily limits below.
const USAGE_LIMITS_OPEN_FOR_ALL = true;

// ── Live FX rate via CBR (CNY → USD cross rate) ──────────────────────────────
let fxCache = { rate: null, ts: 0 };
function parseCBRValue(xml, code) {
  const idx = xml.indexOf(`<CharCode>${code}</CharCode>`);
  if (idx === -1) return null;
  const blockStart = xml.lastIndexOf('<Valute ', idx);
  const blockEnd = xml.indexOf('</Valute>', idx);
  const block = xml.slice(blockStart, blockEnd);
  const nomMatch = block.match(/<Nominal>(\d+)<\/Nominal>/);
  const valMatch = block.match(/<Value>([\d,]+)<\/Value>/);
  if (!nomMatch || !valMatch) return null;
  return parseFloat(valMatch[1].replace(',', '.')) / parseFloat(nomMatch[1]);
}
async function getCnyToUsdRate() {
  const TTL = 12 * 60 * 60 * 1000;
  if (fxCache.rate && (Date.now() - fxCache.ts) < TTL) return fxCache.rate;
  try {
    const r = await fetch('https://www.cbr.ru/scripts/XML_daily.asp');
    const xml = await r.text();
    const usdRub = parseCBRValue(xml, 'USD');
    const cnyRub = parseCBRValue(xml, 'CNY');
    if (usdRub && cnyRub) {
      const rate = cnyRub / usdRub;
      fxCache = { rate, ts: Date.now() };
      return rate;
    }
  } catch (e) { console.error('CBR fetch failed:', e.message); }
  return fxCache.rate || 0.139; // fallback approx if CBR unreachable
}
function toUsd(cny, rate) { return Math.round(cny * rate * 100) / 100; }

// ── Init Database ─────────────────────────────────────────────────────────
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

// ── Middleware ────────────────────────────────────────────────────────────
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

// ── Auth Routes ───────────────────────────────────────────────────────────
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
    res.json({ token, user: { email: user.email, plan: user.plan, daily_count: 0, limit: PLAN_LIMITS[user.plan], unlimited_testing: USAGE_LIMITS_OPEN_FOR_ALL } });
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
    res.json({ token, user: { email: user.email, plan: user.plan, daily_count: fresh.daily_count, limit: PLAN_LIMITS[user.plan] || 5, unlimited_testing: USAGE_LIMITS_OPEN_FOR_ALL } });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await resetIfNewDay(req.user.id);
    res.json({ email: user.email, plan: user.plan, plan_name: PLAN_NAMES[user.plan], daily_count: user.daily_count, limit: PLAN_LIMITS[user.plan] || 5, unlimited_testing: USAGE_LIMITS_OPEN_FOR_ALL });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Analyze Route ─────────────────────────────────────────────────────────
app.post('/api/analyze', requireAuth, async (req, res) => {
  try {
    const user = await resetIfNewDay(req.user.id);
    const limit = PLAN_LIMITS[user.plan] || 5;

    if (!USAGE_LIMITS_OPEN_FOR_ALL && user.daily_count >= limit) {
      return res.status(429).json({
        error: `Лимит исчерпан: ${limit} запросов/день на тарифе «${PLAN_NAMES[user.plan]}». Напиши @VIKTOR_CN1 в Telegram для апгрейда.`,
        limitReached: true
      });
    }

    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: 'Нет изображения' });
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API ключ не настроен на сервере' });

    const prompt = `You are an expert China sourcing analyst with deep knowledge of Chinese manufacturing clusters (e.g. Yiwu = small commodities/daily goods, Shenzhen/Zhongshan/Dongguan = electronics/lighting, Foshan/Shunde = furniture/appliances, Jieyang/Yangjiang = stainless steel/hardware, Quanzhou/Jinjiang = shoes/textiles, Ningbo = plastics/molds, Guangzhou = apparel/leather goods, Wenzhou = eyewear/lighters/locks). Analyze this product image for a China B2B sourcing app and return ONLY a raw JSON object (no markdown, no backticks, just valid JSON) with this EXACT structure:

{"productName":"Russian name 2-4 words","productNameCN":"Chinese characters name","category":"category in Russian","material":"main material in Russian","style":"design style in Russian e.g. Японский минимализм","application":"use cases in Russian max 3 separated by · symbol","confidence":95,
"region":{"cluster":"Chinese city/region name e.g. Yiwu, Zhejiang","reason":"1 sentence in Russian explaining WHY this region dominates production of this product type — mention the industrial cluster specialization"},
"priceAnalysis":{"wholesaleLow":8.5,"wholesaleHigh":15.8,"wholesaleAvg":11.2,"unit":"CNY","verdict":"Russian text: e.g. Среднерыночная цена / Выгодное предложение / Завышенная цена — based on category typical margins"},
"keywords":{"cn":["keyword1","keyword2","keyword3","keyword4"],"en":["keyword1","keyword2","keyword3"]},
"suppliers":[
{"name":"Realistic Chinese manufacturer company name matching the region cluster","type":"manufacturer","regionMatch":true,"rating":4.8,"reviews":3214,"monthlySales":"42,800","priceMin":8.5,"priceMax":15.8,"priceVsAvg":"below","moq":"200 шт","capital":"300万","years":9,"location":"Yiwu, Zhejiang","staff":"50–100","cert":"ISO 9001","managerName":"Realistic Chinese name e.g. 王经理 (Wang)","managerPhone":"+86 138-XXXX-XXXX realistic format"},
{"name":"Second manufacturer matching region","type":"manufacturer","regionMatch":true,"rating":4.7,"reviews":1876,"monthlySales":"28,400","priceMin":10.2,"priceMax":18.5,"priceVsAvg":"average","moq":"100 шт","capital":"500万","years":12,"location":"Ningbo, Zhejiang","staff":"100–200","cert":"","managerName":"Realistic Chinese name","managerPhone":"+86 139-XXXX-XXXX"},
{"name":"Third manufacturer","type":"manufacturer","regionMatch":true,"rating":4.6,"reviews":1502,"monthlySales":"19,300","priceMin":9.0,"priceMax":16.0,"priceVsAvg":"below","moq":"300 шт","capital":"200万","years":6,"location":"matching region city","staff":"30–50","cert":"","managerName":"Realistic Chinese name","managerPhone":"+86 137-XXXX-XXXX"},
{"name":"Fourth manufacturer, possibly from a DIFFERENT region (set regionMatch false) if realistic","type":"manufacturer","regionMatch":false,"rating":4.5,"reviews":980,"monthlySales":"12,100","priceMin":12.0,"priceMax":20.0,"priceVsAvg":"above","moq":"500 шт","capital":"150万","years":4,"location":"a plausible but non-primary region","staff":"20–50","cert":"","managerName":"Realistic Chinese name","managerPhone":"+86 136-XXXX-XXXX"},
{"name":"Chinese trading company (not factory)","type":"trader","regionMatch":false,"rating":4.5,"reviews":892,"priceMin":15.0,"priceMax":28.0,"priceVsAvg":"above","years":4,"location":"Guangzhou, GD","managerName":"Realistic Chinese name","managerPhone":"+86 135-XXXX-XXXX"}
],
"outreachMessageCN":"A polite, professional WeChat/1688 message IN CHINESE asking: are you the actual manufacturer or a trading company, what is your MOQ, and please share contact details. Keep it short, 3-4 sentences, business tone.",
"outreachMessageRU":"Russian translation of the same message for the user's reference"}

All prices (wholesaleLow/High/Avg and every supplier's priceMin/priceMax) MUST be in Chinese Yuan (CNY) and consistent in magnitude with each other. Return exactly 5 suppliers (4 manufacturers + 1 trader). Use realistic Chinese company names, cities, pricing, and manager names appropriate for THIS specific product type and its real-world manufacturing region.`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2200, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } }, { type: 'text', text: prompt }] }] })
    });

    if (!apiRes.ok) {
      const e = await apiRes.json().catch(() => ({}));
      throw new Error(e.error?.message || 'Anthropic API error ' + apiRes.status);
    }

    const apiData = await apiRes.json();
    const txt = apiData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const result = JSON.parse(txt.replace(/```json|```/g, '').trim());

    // Attach live CNY→USD conversion (CBR cross-rate)
    const rate = await getCnyToUsdRate();
    if (result.priceAnalysis) {
      result.priceAnalysis.usdLow = toUsd(result.priceAnalysis.wholesaleLow, rate);
      result.priceAnalysis.usdHigh = toUsd(result.priceAnalysis.wholesaleHigh, rate);
      result.priceAnalysis.usdAvg = toUsd(result.priceAnalysis.wholesaleAvg, rate);
    }
    if (Array.isArray(result.suppliers)) {
      result.suppliers.forEach(s => {
        if (s.priceMin != null) s.usdMin = toUsd(s.priceMin, rate);
        if (s.priceMax != null) s.usdMax = toUsd(s.priceMax, rate);
      });
    }
    result.fxRate = rate;

    await pool.query('UPDATE users SET daily_count = daily_count + 1 WHERE id = $1', [user.id]);

    res.json({ ...result, usage: { count: user.daily_count + 1, limit, plan: user.plan, unlimited_testing: USAGE_LIMITS_OPEN_FOR_ALL } });
  } catch (e) {
    console.error('Analyze error:', e.message);
    res.status(500).json({ error: e.message || 'Ошибка анализа' });
  }
});

// ── Generate Ozon Card (free bonus — does not consume daily limit) ─────────
app.post('/api/generate-card', requireAuth, async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API ключ не настроен на сервере' });
    const { productName, productNameCN, category, material, style, application } = req.body;
    if (!productName) return res.status(400).json({ error: 'Нет данных о товаре' });

    const prompt = `You are an expert Russian e-commerce copywriter specializing in Ozon/Wildberries product listings. Based on this product data, write a high-converting Ozon product card. Return ONLY raw JSON (no markdown, no backticks):
{"title":"SEO title for Ozon, max 60 chars, in Russian, includes key search terms","shortDescription":"1-2 sentence hook in Russian","bullets":["feature 1 in Russian","feature 2","feature 3","feature 4"],"fullDescription":"3-4 paragraph persuasive Russian description for the Ozon card, selling benefits not just specs, written in natural Russian marketplace style","seoKeywords":["keyword1","keyword2","keyword3","keyword4","keyword5"]}

Product: ${productName} (${productNameCN || ''}). Category: ${category || ''}. Material: ${material || ''}. Style: ${style || ''}. Use cases: ${application || ''}.`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
    });
    if (!apiRes.ok) {
      const e = await apiRes.json().catch(() => ({}));
      throw new Error(e.error?.message || 'Anthropic API error ' + apiRes.status);
    }
    const apiData = await apiRes.json();
    const txt = apiData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const result = JSON.parse(txt.replace(/```json|```/g, '').trim());
    res.json(result);
  } catch (e) {
    console.error('Generate-card error:', e.message);
    res.status(500).json({ error: e.message || 'Ошибка генерации карточки' });
  }
});

// ── Market Fit Analysis — Pro tier only ──────────────────────────────────────
app.post('/api/market-fit', requireAuth, async (req, res) => {
  try {
    const user = await resetIfNewDay(req.user.id);
    if (!MARKET_FIT_OPEN_FOR_ALL && !PRO_PLANS.includes(user.plan)) {
      return res.status(403).json({
        error: 'Анализ маркетплейсов доступен на тарифе «Про» и выше. Напиши @VIKTOR_CN1 в Telegram для апгрейда.',
        upgradeRequired: true
      });
    }
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API ключ не настроен на сервере' });
    const { productName, category, material, style, application, priceAnalysis } = req.body;
    if (!productName) return res.status(400).json({ error: 'Нет данных о товаре' });

    const priceHint = priceAnalysis ? `Wholesale price range: $${priceAnalysis.usdLow}-${priceAnalysis.usdHigh} (¥${priceAnalysis.wholesaleLow}-${priceAnalysis.wholesaleHigh}).` : '';

    const prompt = `You are a senior e-commerce market analyst. Based on your general training knowledge of market trends (this is an ESTIMATE, not live marketplace scraping — be calibrated and honest), assess this product's sales potential on 4 platforms. Return ONLY raw JSON (no markdown, no backticks):
{"platforms":[{"name":"eBay","verdict":"Высокий потенциал / Средний / Низкий","reason":"1 sentence in Russian"},{"name":"Shopify / дропшиппинг","verdict":"...","reason":"..."},{"name":"Wildberries","verdict":"...","reason":"..."},{"name":"Ozon","verdict":"...","reason":"..."}],"competitionScore":7,"competitionLabel":"Russian label e.g. Высокая конкуренция / Средняя конкуренция / Низкая конкуренция","summary":"2-3 sentences in Russian summarizing overall market fit and a practical recommendation"}

Product: ${productName}. Category: ${category||''}. Material: ${material||''}. Style: ${style||''}. Use cases: ${application||''}. ${priceHint}`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 900, messages: [{ role: 'user', content: prompt }] })
    });
    if (!apiRes.ok) {
      const e = await apiRes.json().catch(() => ({}));
      throw new Error(e.error?.message || 'Anthropic API error ' + apiRes.status);
    }
    const apiData = await apiRes.json();
    const txt = apiData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const result = JSON.parse(txt.replace(/```json|```/g, '').trim());
    res.json(result);
  } catch (e) {
    console.error('Market-fit error:', e.message);
    res.status(500).json({ error: e.message || 'Ошибка анализа' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 BuyerAI running on port ${PORT}`));
}).catch(e => {
  console.error('Failed to init DB:', e.message);
  process.exit(1);
});
