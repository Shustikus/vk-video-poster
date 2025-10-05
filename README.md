# VK Video Poster Resolver

Скрипт для массового получения и обновления постеров (обложек) видео ВКонтакте.  
Работает через VK API (`video.get`) и fallback-методы (страницы `embed`/`canonical`), с учётом ретраев, rate-limit, и выбора лучшего постера по качеству.

## Требования

- Node.js 18+
- Токен VK API (user/service token с правом `video`)
-  **Примечание:** токен можно получить через <a href="https://vkhost.github.io/" target="_blank">VKHost</a>.
- Файл `videoItems.json` с массивом объектов вида:

```json
[
  {
    "link": "https://vk.com/video_ext.php?oid=123&id=456&hash=...",
    "poster": null
  }
]
````

## Установка

```bash
git clone https://github.com/Shustikus/vk-video-poster.git
cd vk-video-poster
npm install
```

Поменяй вк токен в файле `.env`:

```env
VK_TOKEN=ваш_токен
VK_API_VERSION=5.199
```

## Использование

```bash
node index.js videoItems.json
```

### Аргументы

* `--force` — перезаписывать постеры даже у тех элементов, где они уже есть.
* `--concurrency=N` — число параллельных запросов (по умолчанию 2).
* `--debug` — подробные логи.

### Пример

```bash
node index.js videoItems.json --force --concurrency=4 --debug
```

## Результат работы

* Обновлённый `videoItems.json` (перезаписывается атомарно через `.tmp`).
* Файл `failed.log` — список проблемных кейсов (если такие были).
* Подробная сводка в консоли: количество обновлений, пропусков, ошибок, статистика по источникам (`vk_get`, `embed`, `canonical`, `mycdn`, `og_only`).

## Логика поиска постеров

1. **VK API `video.get`** — основной способ, быстрый и надёжный.
2. **Embed-страница (`video_ext.php`)** — поиск постера в HTML (mycdn/og:image).
3. **Canonical-страница (`vk.com/video...`)** — fallback при неудаче.

## Ограничения

* Максимум 10 000 видео на владельца (ограничение `video.get`).
* При rate-limit VK автоматически выполняются повторные попытки с backoff.
