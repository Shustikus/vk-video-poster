// -*- coding: utf-8 -*-
// Обновляем "poster" у ссылок VK через ТОЛЬКО video.get + парсинг страниц.
// Поле link НЕ меняем. Фолбэк: ТОЛЬКО i.mycdn.me/getVideoPreview
// приоритет fn: vid_x > vid_w > vid_u > vid_l, затем по ширине.
//
// Зависимости: npm i axios dotenv
// .env: VK_TOKEN=xxxxx  (опц. VK_API_VERSION=5.199)
//
// Что изменено:
// 1) Упростил структуру: общий парсер HTML и один fetchPosterFromUrl()
// 2) Добавил подробные логи: прогресс, ретраи, источники, ошибки, сводную статистику
// 3) Параметры CLI:  --force  --concurrency=2  --debug
//
// Пример:
//   node index.js videoItems.json --concurrency=3 --debug
//   node index.js videoItems.json --force
//
// Автор: упрощено и прокомментировано

const fs = require('fs/promises')
const path = require('path')
const axios = require('axios')
require('dotenv').config()

const VK_TOKEN = process.env.VK_TOKEN
const VK_API_VERSION = process.env.VK_API_VERSION
const API_ROOT = 'https://api.vk.com/method'

if (!VK_TOKEN) {
	console.error('❌ Установите VK_TOKEN в .env или окружении')
	process.exit(1)
}

// ---------- CLI ----------
const argv = process.argv.slice(2)
if (!argv.length) {
	console.error('❌ Укажи путь к JSON-файлу: node index.js videoItems.json')
	process.exit(1)
}
const dataFilePath = path.resolve(process.cwd(), argv[0])
const FORCE = argv.includes('--force')

function getArgNum(name, def) {
	const re = new RegExp(`--${name}=(\\d+)`)
	const m = argv.join(' ').match(re)
	return m ? Number(m[1]) : def
}

const CONCURRENCY = Math.max(1, getArgNum('concurrency', 2))
const DEBUG = argv.includes('--debug')

// ---------- Логгер (без зависимостей) ----------
const stats = {
	total: 0,
	updated: 0,
	skipped: 0,
	errors: 0,
	notFound: 0,
	retries: 0,
	rateLimits: 0,
	sources: {vk_get: 0, embed: 0, canonical: 0, og_only: 0, mycdn: 0},
	perReason: {} // агрегируем причины в debug
}

const ts = () => new Date().toISOString().split('T').join(' ').replace('Z', '')
const log = {
	info: (...a) => console.log(`[${ts()}]`, 'ℹ️', ...a),
	ok: (...a) => console.log(`[${ts()}]`, '✅', ...a),
	warn: (...a) => console.log(`[${ts()}]`, '⚠️', ...a),
	err: (...a) => console.log(`[${ts()}]`, '❌', ...a),
	dbg: (...a) => DEBUG && console.log(`[${ts()}]`, '🔎', ...a)
}

function addReason(reason) {
	stats.perReason[reason] = (stats.perReason[reason] || 0) + 1
}

// ---------- Хелперы ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (ms) => ms + Math.floor(Math.random() * 150)

function htmlDecodeUrl(u) {
	return typeof u === 'string' ? u.replace(/&amp;/g, '&') : u
}

function parseVideoLink(link) {
	try {
		const u = new URL(link)
		const owner_id = u.searchParams.get('oid')
		const video_id = u.searchParams.get('id')
		if (!owner_id || !video_id) return null
		return {
			owner_id: Number(owner_id),
			video_id: Number(video_id),
			extUrl: link
		}
	} catch {
		return null
	}
}

// --- сортировка по fn-приоритету (vid_x > vid_w > vid_u > vid_l), затем по ширине
const fnPriority = {vid_x: 4, vid_w: 3, vid_u: 2, vid_l: 1}

function getFn(urlStr) {
	try {
		const u = new URL(htmlDecodeUrl(urlStr))
		return u.searchParams.get('fn') || ''
	} catch {
		return ''
	}
}

function isMyCdnPreview(urlStr) {
	try {
		const u = new URL(htmlDecodeUrl(urlStr))
		return u.hostname === 'i.mycdn.me' && u.pathname.includes('/getVideoPreview')
	} catch {
		return false
	}
}

function pickBestByWidth(pairs) {
	if (!pairs.length) return null
	let best = pairs[0]
	for (const p of pairs) {
		const wA = Number(best.width || 0)
		const wB = Number(p.width || 0)
		if (wB > wA) best = p
	}
	return best.url || null
}

function pickBestMyCdn(candidates) {
	if (!candidates.length) return null
	const scored = candidates.map((c) => {
		const fn = getFn(c.url)
		return {...c, fn, score: fnPriority[fn] || 0}
	})
	scored.sort((a, b) => (b.score - a.score) || ((b.width || 0) - (a.width || 0)))
	return htmlDecodeUrl(scored[0].url)
}

// ---------- Парсер HTML (общий для embed/canonical) ----------
function extractPairsUrlWidth(text) {
	// Вытаскиваем пары "url" + "width" в любом порядке (без cheerio — быстрее и проще)
	const re1 = /["']url["']\s*:\s*["']([^"']+)["'][^{}]*?["']width["']\s*:\s*(\d+)/g
	const re2 = /["']width["']\s*:\s*(\d+)[^{}]*?["']url["']\s*:\s*["']([^"']+)["']/g
	const pairs = []
	let m
	while ((m = re1.exec(text)) !== null) pairs.push({
		url: htmlDecodeUrl(m[1]),
		width: Number(m[2])
	})
	while ((m = re2.exec(text)) !== null) pairs.push({
		url: htmlDecodeUrl(m[2]),
		width: Number(m[1])
	})
	return pairs
}

function extractAnyImageUrls(text) {
	const out = []
	const reAny = /(https?:\/\/[^\s"'<>]+?\.(?:jpg|jpeg|png))/gi
	const seen = new Set()
	let m
	while ((m = reAny.exec(text)) !== null) {
		const url = htmlDecodeUrl(m[1])
		if (!seen.has(url)) {
			seen.add(url)
			out.push(url)
		}
	}
	return out
}

function extractOgImage(text) {
	const og = text.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
	return og ? htmlDecodeUrl(og[1]) : null
}

// Единый сканер HTML: пытается mycdn (с width/fn), потом любые mycdn, потом og:image
function scanHtmlForPoster(html) {
	const pairs = extractPairsUrlWidth(html).filter(p => isMyCdnPreview(p.url))
	if (pairs.length) {
		const best = pickBestMyCdn(pairs)
		if (best) return {url: best, source: 'mycdn'}
	}
	const any = extractAnyImageUrls(html).filter(u => isMyCdnPreview(u))
	if (any.length) {
		const best = pickBestMyCdn(any.map(u => ({url: u, width: 0})))
		if (best) return {url: best, source: 'mycdn'}
	}
	const og = extractOgImage(html)
	if (og) return {url: og, source: 'og_only'}
	return {url: null, source: null}
}

// ---------- VK API с ретраями и логами ----------
async function vk(method, params, attempt = 1) {
	const MAX_ATTEMPTS = 6
	try {
		const {data} = await axios.get(`${API_ROOT}/${method}`, {
			params: {...params, access_token: VK_TOKEN, v: VK_API_VERSION},
			timeout: 15000,
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
			}
		})
		if (data.error) {
			const e = data.error
			if (e.error_code === 6 && attempt < MAX_ATTEMPTS) {
				stats.rateLimits++
				const wait = jitter(Math.min(1000 * Math.pow(1.7, attempt), 5000))
				log.warn(`VK rate limit (code=6). Retry #${attempt} через ${wait}ms`)
				stats.retries++
				await sleep(wait)
				return vk(method, params, attempt + 1)
			}
			const err = new Error(`VK error ${e.error_code}: ${e.error_msg}`)
			err.vk = e
			throw err
		}
		return data.response
	} catch (net) {
		if (attempt < MAX_ATTEMPTS) {
			const wait = jitter(Math.min(1000 * Math.pow(1.7, attempt), 5000))
			log.warn(`VK сеть/таймаут. Retry #${attempt} через ${wait}ms`)
			stats.retries++
			await sleep(wait)
			return vk(method, params, attempt + 1)
		}
		throw net
	}
}

// ---- 1) Основной путь: ТОЛЬКО video.get ----
async function fetchPosterViaGet(owner_id, target_video_id) {
	const COUNT = 200
	for (let offset = 0; offset < 10000; offset += COUNT) {
		if (DEBUG) log.dbg(`video.get owner=${owner_id} offset=${offset}`)
		const resp = await vk('video.get', {owner_id, count: COUNT, offset})
		const items = resp?.items || []
		if (!items.length) break
		
		const found = items.find((v) => String(v.id) === String(target_video_id))
		if (found) {
			if (Array.isArray(found.image) && found.image.length) {
				const pairs = found.image.map(it => ({
					url: htmlDecodeUrl(it.url),
					width: it.width || 0
				}))
				// даже если тут не mycdn, это «официальный» постер — возвращаем сразу
				const best = pickBestByWidth(pairs)
				if (best) return {url: best, source: 'vk_get'}
			}
			for (const k of ['photo_800', 'photo_640', 'photo_320', 'photo_130']) {
				if (found[k]) return {url: htmlDecodeUrl(found[k]), source: 'vk_get'}
			}
			return {url: null, source: 'vk_get'}
		}
		if (items.length < COUNT) break
	}
	return {url: null, source: null}
}

// ---------- 2) Универсальный фетчер страницы (embed/canonical) ----------
async function fetchPosterFromUrl(url, tag) {
	try {
		const {data: html} = await axios.get(url, {
			timeout: 15000,
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
				Referer: 'https://vk.com/'
			}
		})
		const {url: poster, source} = scanHtmlForPoster(html)
		if (poster) return {
			url: poster,
			source: source === 'mycdn' ? tag : 'og_only'
		}
	} catch (e) {
		if (DEBUG) log.dbg(`${tag} fetch error:`, e.message)
	}
	return {url: null, source: null}
}

// ---------- 3) Фолбэки: embed (extUrl) и canonical ----------
async function fetchPosterFromEmbed(extUrl) {
	return fetchPosterFromUrl(extUrl, 'embed')
}

async function fetchPosterFromCanonical(owner_id, video_id) {
	const urls = [
		`https://vk.com/video${owner_id}_${video_id}`,
		`https://vk.com/video${owner_id}_${video_id}?nojs=1`
	]
	for (const u of urls) {
		const got = await fetchPosterFromUrl(u, 'canonical')
		if (got.url) return got
	}
	return {url: null, source: null}
}

// ---------- Резолв одного элемента с логами ----------
async function resolvePosterForItem(item, i, total, debugBag) {
	const t0 = Date.now()
	const label = `#${i + 1}/${total}`
	
	if (!FORCE && item.poster) {
		stats.skipped++
		log.dbg(`${label} пропуск — poster уже есть`)
		return item.poster
	}
	
	const ids = parseVideoLink(item.link)
	if (!ids) {
		addReason('parse_failed')
		debugBag.push({link: item.link, reason: 'parse_failed'})
		stats.notFound++
		log.warn(`${label} parse_failed: link=${item.link}`)
		return item.poster || null
	}
	
	// 1) video.get
	try {
		const r = await fetchPosterViaGet(ids.owner_id, ids.video_id)
		if (r.url) {
			stats.sources.vk_get++
			const ms = Date.now() - t0
			log.ok(`${label} найден через VK API (video.get) за ${ms}ms`)
			return r.url
		}
	} catch (e) {
		addReason('video.get_error')
		debugBag.push({
			link: item.link,
			reason: 'video.get_error',
			message: e.message
		})
		log.warn(`${label} video.get_error: ${e.message}`)
	}
	
	// 2) embed
	try {
		const r = await fetchPosterFromEmbed(ids.extUrl)
		if (r.url) {
			if (r.source === 'og_only') stats.sources.og_only++
			else stats.sources.embed++, stats.sources.mycdn++
			const ms = Date.now() - t0
			log.ok(`${label} найден через embed (${r.source}) за ${ms}ms`)
			return r.url
		}
	} catch (e) {
		addReason('embed_error')
		debugBag.push({link: item.link, reason: 'embed_error', message: e.message})
		log.warn(`${label} embed_error: ${e.message}`)
	}
	
	// 3) canonical
	try {
		const r = await fetchPosterFromCanonical(ids.owner_id, ids.video_id)
		if (r.url) {
			if (r.source === 'og_only') stats.sources.og_only++
			else stats.sources.canonical++, stats.sources.mycdn++
			const ms = Date.now() - t0
			log.ok(`${label} найден через canonical (${r.source}) за ${ms}ms`)
			return r.url
		}
	} catch (e) {
		addReason('canonical_error')
		debugBag.push({
			link: item.link,
			reason: 'canonical_error',
			message: e.message
		})
		log.warn(`${label} canonical_error: ${e.message}`)
	}
	
	addReason('not_found_anywhere')
	debugBag.push({link: item.link, reason: 'not_found_anywhere'})
	stats.notFound++
	log.warn(`${label} постер не найден ни одним способом`)
	return item.poster || null
}

// ---------- Параллельная обработка с мягким джиттером ----------
async function mapWithConcurrency(items, limit, mapper) {
	const results = new Array(items.length)
	let idx = 0
	
	async function worker() {
		while (true) {
			const i = idx++
			if (i >= items.length) break
			try {
				if (i) await sleep(jitter(60)) // мелкий рассинхрон запросов
				results[i] = await mapper(items[i], i)
			} catch (e) {
				results[i] = null
			}
		}
	}
	
	const workers = Array.from({length: Math.min(limit, items.length)}, worker)
	await Promise.all(workers)
	return results
}

// ---------- main ----------
async function main() {
	const raw = await fs.readFile(dataFilePath, 'utf8')
	const videoItems = JSON.parse(raw)
	stats.total = videoItems.length
	
	log.info(`📦 Загружено элементов: ${videoItems.length}`)
	if (FORCE) log.info('🔁 --force: перезаписываем постеры у всех элементов.')
	log.info(`🔧 VK API v=${VK_API_VERSION || 'default'}; concurrency=${CONCURRENCY}; debug=${DEBUG}`)
	
	let updatedCount = 0
	const debugBag = []
	
	await mapWithConcurrency(videoItems, CONCURRENCY, async (item, i) => {
		const before = item.poster || null
		const after = await resolvePosterForItem(item, i, videoItems.length, debugBag)
		if (after && after !== before) {
			item.poster = after
			updatedCount++
			log.dbg(`#${i + 1}/${videoItems.length} poster обновлён`)
		}
		if (!after || after === before) {
			// если ничего не изменилось и poster пуст — считаем как notFound уже учтён
			// если poster был, и остался тем же — просто пропуск
		}
	})
	
	// Перезаписываем файл (через .tmp)
	const json = JSON.stringify(videoItems, null, 2)
	const tmpPath = dataFilePath + '.tmp'
	await fs.writeFile(tmpPath, json, 'utf8')
	await fs.rename(tmpPath, dataFilePath)
	
	if (debugBag.length) {
		const lines = debugBag.map(d => JSON.stringify(d)).join('\n') + '\n'
		await fs.writeFile('failed.log', lines, 'utf8')
		log.info(`ℹ️  Проблемные кейсы записаны в failed.log (${debugBag.length})`)
	}
	
	stats.updated = updatedCount
	// Вычислим "skipped" как элементы с уже существующим poster и без FORCE
	// точный подсчёт мы делали онлайн, но если нужно — можно оставить как есть.
	log.ok(`Готово. Обновлено: ${updatedCount} из ${videoItems.length}`)
	
	// ---------- Сводка по источникам и ретраям ----------
	const summary = {
		total: stats.total,
		updated: stats.updated,
		skipped: stats.skipped,
		notFound: stats.notFound,
		retries: stats.retries,
		rateLimits: stats.rateLimits,
		sources: stats.sources,
		reasons: stats.perReason
	}
	log.info('📊 Сводка:', JSON.stringify(summary, null, 2))
}

main().catch((e) => {
	log.err('Фатальная ошибка:', e.message || e)
	process.exit(1)
})
