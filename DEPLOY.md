# 🚀 Деплой BuyerAI на Railway — пошаговая инструкция

## Что нужно (всё бесплатно):
- Аккаунт GitHub: github.com
- Аккаунт Railway: railway.app
- Anthropic API ключ: console.anthropic.com

---

## Шаг 1 — Загрузи код на GitHub

1. Зайди на github.com → New repository
2. Название: `buyerai-backend` → Create repository
3. Загрузи все файлы из этой папки в репозиторий
   (кнопка "uploading an existing file" на странице репозитория)

---

## Шаг 2 — Создай проект на Railway

1. Зайди на railway.app → New Project
2. Выбери "Deploy from GitHub repo"
3. Выбери репозиторий `buyerai-backend`
4. Railway автоматически обнаружит Node.js и начнёт деплой

---

## Шаг 3 — Добавь PostgreSQL базу данных

1. В проекте нажми "+ New" → "Database" → "PostgreSQL"
2. Railway создаст базу и автоматически добавит переменную DATABASE_URL

---

## Шаг 4 — Добавь переменные окружения

В Railway → твой сервис → Variables → Add Variable:

| Переменная | Значение |
|-----------|---------|
| ANTHROPIC_API_KEY | sk-ant-api03-твой-ключ |
| JWT_SECRET | любая-длинная-строка-например-buyerai2024secret |
| NODE_ENV | production |

---

## Шаг 5 — Получи ссылку

1. Railway → Settings → Domains → Generate Domain
2. Получишь ссылку типа: `buyerai-backend-production.up.railway.app`
3. Эту ссылку можно отправлять в WeChat группы!

---

## Тарифы пользователей (настраивается в коде)

| Тариф | Запросов/день | Кому |
|-------|--------------|------|
| free | 5 | Новые пользователи |
| basic | 20 | Платящие клиенты |
| pro | 50 | Активные пользователи |
| unlimited | ∞ | VIP |

Для изменения тарифа пользователя — выполни SQL в Railway PostgreSQL:
```sql
UPDATE users SET plan = 'basic' WHERE email = 'client@example.com';
```

---

## Поддержка
Telegram: @VIKTOR_CN1
WeChat: Zaikin1_v
