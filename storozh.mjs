// Проверка прода Stage и сигнал в Telegram (15.10.2026).
// Прод считается лежащим, только если не ответил три раза подряд с паузой 20 секунд:
// разовая ошибка сети не должна будить человека. Пока лежит - напоминание раз в 30
// минут, когда ожил - одно сообщение «снова работает»
//
// Онлайн-запись (19.10.2026, Влад: «если запись станет недоступна, мне тоже должно
// приходить уведомление»). У каждого заведения проверяется то, без чего человек не
// запишется: страница, её скрипт, данные заведения и список специалистов. Запись
// проверяется, только когда сам прод отвечает - если лежит весь прод, о нём уже
// пришло сообщение, и второе про запись было бы тем же событием
//
// Почему цикл внутри запуска (19.10.2026): расписание «раз в 5 минут» GitHub на деле
// запускал раз в 2-4 часа, и падение прода сторож мог заметить через часы. Теперь
// один запуск сам проверяет раз в минуту почти 6 часов, следующий ждёт его в очереди
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const BASE = process.env.STOROZH_BASE ?? 'https://app.wellstage.ru';
const URL = process.env.STOROZH_URL ?? `${BASE}/health`;
// Ссылка заведения и имя для сообщения. Новое заведение - строка здесь
const ZAVEDENIYA = process.env.STOROZH_ZAVEDENIYA
  ? JSON.parse(process.env.STOROZH_ZAVEDENIYA)
  : [
    { slug: 'urbashevichus', name: 'Карины (Урбашевичус)' },
    { slug: 'alikhan', name: 'Алихана' },
  ];
const TRIES = 3;
const PAUSE_MS = Number(process.env.STOROZH_PAUSE_MS ?? 20_000);
const REMIND_MS = 30 * 60_000;
const EVERY_MS = 60_000;
const RUN_MS = Number(process.env.STOROZH_MINUTES ?? 0) * 60_000;
const STATE = 'state/state.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msk = (d = new Date()) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

async function get(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { why: err.name === 'TimeoutError' ? 'нет ответа 15 секунд' : `ошибка сети (${err.cause?.code ?? err.message})` };
  }
}

// Одна попытка: null - всё в порядке, строка - что именно не так
async function probeProd() {
  const r = await get(URL);
  if (r.why) return r.why;
  return r.status === 200 && r.body.includes('"ok":true') ? null : `ответ ${r.status}`;
}

async function probeZapis({ slug }) {
  const steps = [
    ['страница', `${BASE}/${slug}/zapis`, (b) => b.includes('assets/zapis.js')],
    ['скрипт страницы', `${BASE}/${slug}/assets/zapis.js`, (b) => b.length > 1000],
    ['данные заведения', `${BASE}/${slug}/api/public/zavedenie`, (b) => Boolean(JSON.parse(b).name)],
    ['список специалистов', `${BASE}/${slug}/api/public/masters`, (b) => JSON.parse(b).length > 0],
  ];
  for (const [what, url, ok] of steps) {
    const r = await get(url);
    if (r.why) return `${what}: ${r.why}`;
    if (r.status !== 200) return `${what}: ответ ${r.status}`;
    let good = false;
    try { good = ok(r.body); } catch { good = false; }
    if (!good) return `${what}: пустой или не тот ответ`;
  }
  return null;
}

async function withRetries(probe) {
  let why = null;
  for (let i = 0; i < TRIES; i += 1) {
    why = await probe();
    if (!why) return { up: true };
    if (i < TRIES - 1) await sleep(PAUSE_MS);
  }
  return { up: false, why };
}

async function tell(text) {
  const { TG_TOKEN, TG_CHAT_ID } = process.env;
  if (!TG_TOKEN || !TG_CHAT_ID) { console.log('Telegram не настроен, сообщение:', text); return; }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ответил ${res.status}: ${await res.text()}`);
}

// Общая смена состояния для прода и записи: упало - сообщение, лежит - напоминание
// раз в 30 минут, ожило - «снова работает»
async function step(prev, r, now, texts) {
  if (r.up && prev.down) {
    await tell(texts.back(Math.round((now - prev.since) / 60_000)));
    return { down: false };
  }
  if (!r.up && !prev.down) {
    await tell(texts.down(r.why));
    return { down: true, since: now, reminded: now };
  }
  if (!r.up && prev.down && now - prev.reminded >= REMIND_MS) {
    await tell(texts.still(Math.round((now - prev.since) / 60_000), r.why));
    return { ...prev, reminded: now };
  }
  return prev;
}

function save(state) {
  mkdirSync('state', { recursive: true });
  writeFileSync(STATE, JSON.stringify(state));
}

const loaded = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
// Состояние до 19.10.2026 было только про прод: { down, since, reminded }
const state = {
  prod: loaded.prod ?? { down: Boolean(loaded.down), since: loaded.since, reminded: loaded.reminded },
  zapis: loaded.zapis ?? {},
};
const started = Date.now();

async function round() {
  const now = Date.now();
  const prod = await withRetries(probeProd);
  state.prod = await step(state.prod, prod, now, {
    back: (m) => `✅ Прод Stage снова работает (${msk()} МСК). Не отвечал около ${m} мин`,
    down: (why) => `🔴 Прод Stage не отвечает (${msk()} МСК): ${why}.\n${URL}\nКабинеты клиентов сейчас не работают. Первым делом проверь базу proddb в панели Amvera`,
    still: (m, why) => `🔴 Прод Stage всё ещё не отвечает: ${m} мин (${why})`,
  });
  const lines = [prod.up ? 'прод отвечает' : `прод не отвечает: ${prod.why}`];
  // Лежит весь прод - запись не проверяем: о падении уже сказано одним сообщением
  if (prod.up) {
    for (const z of ZAVEDENIYA) {
      const link = `${BASE}/${z.slug}/zapis`;
      const r = await withRetries(() => probeZapis(z));
      state.zapis[z.slug] = await step(state.zapis[z.slug] ?? { down: false }, r, now, {
        back: (m) => `✅ Онлайн-запись у ${z.name} снова открывается (${msk()} МСК). Не работала около ${m} мин\n${link}`,
        down: (why) => `🟠 Онлайн-запись у ${z.name} не открывается (${msk()} МСК): ${why}.\n${link}\nСам прод отвечает, кабинеты работают - не открывается именно страница записи для клиентов`,
        still: (m, why) => `🟠 Онлайн-запись у ${z.name} всё ещё не открывается: ${m} мин (${why})\n${link}`,
      });
      lines.push(`запись ${z.slug}: ${r.up ? 'открывается' : r.why}`);
    }
  }
  save(state);
  console.log(`${msk()} ${lines.join(' · ')}`);
  return lines;
}

// Ручной запуск с галочкой «проверка» - доказать, что сторож на GitHub может писать
if (process.env.STOROZH_PROVERKA === 'true') {
  const lines = await round();
  await tell(`🔧 Проверка связи: сторож на GitHub на месте (${msk()} МСК).\n${lines.join('\n')}`);
} else {
  for (;;) {
    const t = Date.now();
    await round();
    const wait = EVERY_MS - (Date.now() - t);
    if (Date.now() - started + Math.max(wait, 0) >= RUN_MS) break;
    if (wait > 0) await sleep(wait);
  }
}
