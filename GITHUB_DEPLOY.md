# Деплой на GitHub Pages — пошагово

## Шаг 1 — Создай репозиторий на GitHub

1. Зайди на https://github.com/new
2. Название репозитория: `brt-platform` (или любое другое)
3. Public — обязательно (для бесплатного GitHub Pages)
4. Нажми "Create repository"

## Шаг 2 — Измени имя репозитория в конфиге

Если назвал репозиторий НЕ `brt-platform`, открой файл:
`website/vite.config.js` и измени строку:
```
base: process.env.VITE_BASE_PATH || '/brt-platform/',
```
На своё название, например `/my-repo/`

То же самое в `.github/workflows/deploy.yml` строка:
```
VITE_BASE_PATH: /brt-platform/
```

## Шаг 3 — Залей код в GitHub

Скачай и установи Git с https://git-scm.com если не установлен.

Открой папку `brt-project` в проводнике.
Зажми Shift, правый клик на пустом месте → "Открыть окно PowerShell здесь"

Введи команды по одной:
```
git init
git add .
git commit -m "Initial BRT Platform"
git branch -M main
git remote add origin https://github.com/ТУТ_ТВОЙ_ЛОГИН/brt-platform.git
git push -u origin main
```
(Замени ТУТ_ТВОЙ_ЛОГИН на свой GitHub username)

## Шаг 4 — Включи GitHub Pages

1. Открой репозиторий на GitHub
2. Settings → Pages (левое меню)
3. Source: "GitHub Actions"
4. Сохрани

## Шаг 5 — Дождись деплоя

В репозитории вкладка "Actions" — там видно прогресс сборки.
Обычно 1-2 минуты.

После деплоя сайт доступен по адресу:
https://ТУТ_ТВОЙ_ЛОГИН.github.io/brt-platform/

## Обновление сайта

После любых изменений:
```
git add .
git commit -m "Update"
git push
```
GitHub автоматически пересоберёт и задеплоит.

## Важно

- Сайт работает полностью без ноды (кошелёк создаётся в браузере)
- Для реальных транзакций нужна запущенная нода локально или на сервере
- Если нода на сервере — измени NODE_URL в App.jsx на публичный IP
