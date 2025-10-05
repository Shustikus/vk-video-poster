Мини-утилита на Node.js для обновления поля poster у видео по ссылкам VK.
Источники по приоритету: VK API video.get → embed-страница → каноническая страница → og:image.
Поле link не изменяется.

Быстрый старт
npm i
echo "VK_TOKEN=vk1.a.xxxxx" > .env
node index.js videoItems.json

Формат входных данных

videoItems.json — массив объектов с полем link (обязательно) и опциональным poster:

[
  {"link":"https://vk.com/video?oid=-123&id=456","poster":null}
]

Переменные окружения

.env:

VK_TOKEN=vk1.a.xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# VK_API_VERSION=5.199   # опционально

Флаги

--force — перезаписывать poster даже если уже есть

--concurrency=2 — параллельность (по умолчанию 2)

--debug — подробные логи

Что делает

Парсит oid/id из link.

Пытается получить постер через video.get (берёт самое широкое image[] или photo_800/640/...).

Если нет — парсит embed/каноническую страницу, выбирая только i.mycdn.me/getVideoPreview
(приоритет vid_x > vid_w > vid_u > vid_l, затем ширина).

Если mycdn не найден — берёт og:image.

Обновляет poster и перезаписывает исходный JSON (через .tmp).

Проблемные кейсы — в failed.log.

Выход

Консольная сводка (updated/skipped/notFound, источники, ретраи).

failed.log — строки JSON с причинами (parse_failed, video.get_error, embed_error, canonical_error, not_found_anywhere).