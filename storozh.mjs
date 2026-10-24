// Проверка прода Wellstage и сигнал в Telegram (15.10.2026).
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
//
// Почему «лежит» только после трёх минут подряд (24.10.2026). Сторож живёт на GitHub
// в США, прод - в Москве, и дорога между ними рвётся: 24.10 за четыре часа было ~25
// обрывов на минуту, а сервер в это время не перезапускался и из России отвечал.
// Каждый обрыв давал пару «не отвечает» - «снова работает, не отвечал 1 мин», и
// настоящее падение утонуло бы в этом шуме. Теперь сигнал - если прод не отвечает
// три проверки подряд (~3 минуты), «снова работает» - после двух удачных подряд.
// Короткие обрывы не пропадают: их число приходит в утренней сводке за сутки
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
const TRIES = 2;
const PAUSE_MS = Number(process.env.STOROZH_PAUSE_MS ?? 5_000);
const DOWN_ROUNDS = 3;
const UP_ROUNDS = 2;
const REMIND_MS = 30 * 60_000;
const EVERY_MS = Number(process.env.STOROZH_EVERY_MS ?? 60_000);
const RUN_MS = Number(process.env.STOROZH_MINUTES ?? 0) * 60_000;
// Перерыв между проверками дольше этого - сторож сам не работал (сбой GitHub)
const GAP_MS = 10 * 60_000;
// Сводка за прошедшие сутки - первым запуском после 9:00 МСК
const DIGEST_HOUR = 9;
const STATE = 'state/state.json';
// Ручная проверка связи берёт состояние из кэша многочасовой давности - перерыв и
// сводку она не считает, иначе пришло бы ложное «сторож не работал»
const PROVERKA = process.env.STOROZH_PROVERKA === 'true';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (d, o) => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', ...o });
const msk = (d = Date.now()) => fmt(d, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const hm = (d) => fmt(d, { hour: '2-digit', minute: '2-digit' });
const dayOf = (d) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
const hourOf = (d) => Number(fmt(d, { hour: '2-digit', hourCycle: 'h23' }));
const dur = (ms) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
};
const sec = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} с`;

async function get(url) {
  const t = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return { status: res.status, body: await res.text(), ms: Date.now() - t };
  } catch (err) {
    return { net: true, why: err.name === 'TimeoutError' ? 'нет ответа 15 секунд' : `обрыв связи (${err.cause?.code ?? err.message})` };
  }
}

// Одна попытка: { ok, net, why, ms, startedAt }. net - до сервера не достучались
// вовсе, иначе сервер ответил, но не так
async function probeProd() {
  const r = await get(URL);
  if (r.net) return { ok: false, net: true, why: r.why };
  let body = null;
  try { body = JSON.parse(r.body); } catch { body = null; }
  if (r.status === 200 && body?.ok === true) return { ok: true, ms: r.ms, startedAt: body.startedAt };
  return { ok: false, net: false, why: `ответ ${r.status}`, status: r.status };
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
    if (r.net) return { ok: false, net: true, why: `${what}: ${r.why}` };
    if (r.status !== 200) return { ok: false, net: false, why: `${what}: ответ ${r.status}` };
    let good = false;
    try { good = ok(r.body); } catch { good = false; }
    if (!good) return { ok: false, net: false, why: `${what}: пустой или не тот ответ` };
  }
  return { ok: true };
}

async function withRetries(probe) {
  let r = null;
  for (let i = 0; i < TRIES; i += 1) {
    r = await probe();
    if (r.ok) return r;
    if (i < TRIES - 1) await sleep(PAUSE_MS);
  }
  return r;
}

// Сообщение, которое не ушло (24.10: 21.10 Telegram на минуту не нашёлся по имени,
// сторож упал и сообщение пропало), ждёт в очереди и уходит следующей проверкой
async function send(text) {
  const { TG_TOKEN, TG_CHAT_ID } = process.env;
  if (!TG_TOKEN || !TG_CHAT_ID) { console.log('Telegram не настроен, сообщение:\n' + text); return true; }
  for (let i = 0; i < 3; i += 1) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return true;
      console.log(`Telegram ответил ${res.status}: ${await res.text()}`);
    } catch (err) {
      console.log(`Telegram недоступен: ${err.cause?.code ?? err.message}`);
    }
    await sleep(3_000);
  }
  return false;
}

async function tell(text) {
  if (!(await send(text))) state.outbox = [...state.outbox, { text, at: Date.now() }].slice(-20);
}

async function flushOutbox() {
  const left = [];
  for (const m of state.outbox) {
    const text = `${m.text}\n\n(задержалось: Telegram был недоступен в ${hm(m.at)})`;
    if (!(await send(text))) left.push(m);
  }
  // Ключ бота сломан навсегда - очередь не копим бесконечно, держим последние 20
  state.outbox = left.slice(-20);
}

function save() {
  mkdirSync('state', { recursive: true });
  writeFileSync(STATE, JSON.stringify(state));
}

// ── Состояние ───────────────────────────────────────────────────────────────
const loaded = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
// Состояние до 19.10.2026 было только про прод: { down, since, reminded }
const state = {
  prod: loaded.prod ?? { down: Boolean(loaded.down), since: loaded.since, reminded: loaded.reminded },
  zapis: loaded.zapis ?? {},
  days: loaded.days ?? {},
  digestFor: loaded.digestFor ?? null,
  lastRound: loaded.lastRound ?? null,
  startedAt: loaded.startedAt ?? null,
  outbox: loaded.outbox ?? [],
};

// Счётчики суток для сводки
function today(now) {
  const key = dayOf(now);
  state.days[key] ??= { rounds: 0, blips: 0, zapisBlips: {}, outages: [], restarts: [], gaps: [], ms: [] };
  // Храним двое суток: вчера для сводки и сегодня
  for (const k of Object.keys(state.days)) if (k !== key && k !== dayOf(now - 86_400_000)) delete state.days[k];
  return state.days[key];
}

// Общая смена состояния для прода и записи. fails/oks - сколько проверок подряд
// не так/так. Сигнал «не работает» - после DOWN_ROUNDS неудачных подряд, «снова
// работает» - после UP_ROUNDS удачных. Обрыв короче порога - тихий, только в сводку
async function step(prev, r, now, texts, onBlip, onOutage) {
  const s = { down: false, fails: 0, oks: 0, ...prev };
  if (r.ok) {
    if (!s.down) {
      if (s.fails > 0) onBlip();
      return { down: false, fails: 0, oks: 0 };
    }
    s.oks += 1;
    if (s.oks < UP_ROUNDS) return s;
    await tell(texts.back(s.since, now));
    onOutage({ from: s.since, to: now, why: s.why });
    return { down: false, fails: 0, oks: 0 };
  }
  s.oks = 0;
  if (!s.down) {
    s.fails += 1;
    if (s.fails === 1) s.firstFail = now;
    if (s.fails < DOWN_ROUNDS) return s;
    await tell(texts.down(r, s.firstFail));
    return { down: true, since: s.firstFail, reminded: now, why: r.why, fails: 0, oks: 0 };
  }
  s.why = r.why;
  if (now - s.reminded >= REMIND_MS) {
    await tell(texts.still(s.since, now, r));
    s.reminded = now;
  }
  return s;
}

// Что значит ответ прода - чтобы сообщение сразу говорило, куда смотреть
function prodCause(r) {
  if (r.net) return 'сервер не отвечает вовсе: лежит Amvera или связь до неё. Открой app.wellstage.ru с телефона - если не открывается, смотри панель Amvera';
  if (r.status === 500) return 'сервер работает, но не достучался до базы. Первым делом проверь базу proddb в панели Amvera';
  if (r.status >= 502 && r.status <= 504) return 'Amvera не видит запущенное приложение: оно перезапускается или упало. Если не пройдёт за 5 минут - смотри журнал приложения в панели Amvera';
  return 'сервер отвечает не так, как должен';
}

async function round() {
  const now = Date.now();
  const day = today(now);

  // Перерыв в проверках: сторож сам не работал (21.10 GitHub потерял связь с
  // машиной сторожа, и прод не проверялся 5,5 часа, а никто не знал)
  if (!PROVERKA && state.lastRound && now - state.lastRound > GAP_MS) {
    day.gaps.push({ from: state.lastRound, to: now });
    await tell(`⚪️ Сторож Wellstage сам не работал ${dur(now - state.lastRound)}: с ${msk(state.lastRound)} до ${hm(now)} МСК (сбой на стороне GitHub). Прод в это время не проверялся, сейчас проверка снова идёт`);
  }
  if (state.outbox.length) await flushOutbox();

  const prod = await withRetries(probeProd);
  day.rounds += 1;
  if (prod.ok) {
    day.ms.push(prod.ms);
    // Сервер перезапустился - выкладка или сбой. Срочно не пишем, только в сводку
    // и в сообщение о восстановлении, если перезапуск пришёлся на падение
    if (prod.startedAt && state.startedAt && prod.startedAt !== state.startedAt) {
      day.restarts.push(Date.parse(prod.startedAt));
    }
    if (prod.startedAt) state.startedAt = prod.startedAt;
  }
  state.prod = await step(state.prod, prod, now, {
    down: (r, since) => `🔴 Wellstage не работает с ${hm(since)} МСК (${r.why}).\nКабинеты клиентов и онлайн-запись сейчас не открываются.\nЧто это значит: ${prodCause(r)}`,
    still: (since, at, r) => `🔴 Wellstage всё ещё не работает: ${dur(at - since)} (${r.why})`,
    back: (since, at) => {
      const restart = state.startedAt && Date.parse(state.startedAt) >= since
        ? `\nСервер за это время перезапустился в ${hm(Date.parse(state.startedAt))}`
        : '';
      return `✅ Wellstage снова работает (${hm(at)} МСК). Не работал ${dur(at - since)}: с ${hm(since)}${restart}`;
    },
  }, () => { day.blips += 1; }, (o) => day.outages.push({ what: 'prod', ...o }));

  const lines = [prod.ok ? `прод отвечает ${prod.ms} мс` : `прод не отвечает: ${prod.why}`];
  // Прод не ответил - запись не проверяем: о падении скажет сообщение про прод
  if (prod.ok) {
    for (const z of ZAVEDENIYA) {
      const link = `${BASE}/${z.slug}/zapis`;
      const r = await withRetries(() => probeZapis(z));
      state.zapis[z.slug] = await step(state.zapis[z.slug] ?? {}, r, now, {
        down: (x, since) => `🟠 Онлайн-запись у ${z.name} не открывается с ${hm(since)} МСК: ${x.why}.\n${link}\nКабинеты работают - не открывается именно страница записи для клиентов`,
        still: (since, at, x) => `🟠 Онлайн-запись у ${z.name} всё ещё не открывается: ${dur(at - since)} (${x.why})\n${link}`,
        back: (since, at) => `✅ Онлайн-запись у ${z.name} снова открывается (${hm(at)} МСК). Не работала ${dur(at - since)}: с ${hm(since)}\n${link}`,
      }, () => { day.zapisBlips[z.slug] = (day.zapisBlips[z.slug] ?? 0) + 1; },
      (o) => day.outages.push({ what: z.slug, ...o }));
      lines.push(`запись ${z.slug}: ${r.ok ? 'открывается' : r.why}`);
    }
  }

  state.lastRound = now;
  if (!PROVERKA) await maybeDigest(now);
  save();
  console.log(`${msk(now)} ${lines.join(' · ')}`);
  return lines;
}

// ── Сводка за сутки ────────────────────────────────────────────────────────
// Раз в день, первым запуском после 9:00 МСК. Заодно знак, что сторож жив:
// нет сводки к 10 утра - сам сторож не работает
function digestText(key, d) {
  const name = (slug) => (slug === 'prod' ? 'Весь Wellstage' : `Онлайн-запись ${ZAVEDENIYA.find((z) => z.slug === slug)?.name ?? slug}`);
  const downMs = d.outages.filter((o) => o.what === 'prod').reduce((a, o) => a + (o.to - o.from), 0);
  const seen = Math.max(d.rounds * EVERY_MS, downMs);
  const uptime = seen ? 100 - (downMs / seen) * 100 : 100;
  const ms = [...d.ms].sort((a, b) => a - b);
  const out = [`📊 Wellstage за ${key.slice(0, 5)}: сводка сторожа`];
  out.push(d.outages.length
    ? `Простои: ${d.outages.map((o) => `${name(o.what)} ${hm(o.from)}-${hm(o.to)} (${dur(o.to - o.from)})`).join('; ')}`
    : 'Простоев не было');
  out.push(`Доступность: ${uptime.toFixed(uptime === 100 ? 0 : 2).replace('.', ',')}%`);
  if (ms.length) out.push(`Скорость ответа: обычно ${sec(ms[Math.floor(ms.length / 2)])}, медленнее всего ${sec(ms[ms.length - 1])}`);
  if (d.restarts.length) out.push(`Перезапуски сервера (выкладка или сбой): ${d.restarts.map(hm).join(', ')}`);
  const zb = Object.entries(d.zapisBlips).map(([s, n]) => `${s} ${n}`).join(', ');
  out.push(`Короткие обрывы связи GitHub - Amvera, без сигнала: прод ${d.blips}${zb ? `, запись ${zb}` : ''}. Это сеть до сервера, клиенты их скорее всего не заметили`);
  const gapMs = d.gaps.reduce((a, g) => a + (g.to - g.from), 0);
  out.push(gapMs
    ? `Сторож сам не работал ${dur(gapMs)} - в это время прод не проверялся`
    : `Сторож проверял весь день: ${d.rounds} проверок`);
  return out.join('\n');
}

async function maybeDigest(now) {
  if (hourOf(now) < DIGEST_HOUR) return;
  const key = dayOf(now - 86_400_000);
  if (state.digestFor === key || !state.days[key]) return;
  await tell(digestText(key, state.days[key]));
  state.digestFor = key;
}

// Ручной запуск с галочкой «проверка» - доказать, что сторож на GitHub может писать
if (PROVERKA) {
  const lines = await round();
  const d = state.days[dayOf(Date.now())];
  await tell(`🔧 Проверка связи: сторож на GitHub на месте (${msk()} МСК).\n${lines.join('\n')}${d ? `\n\nСегодня до этой минуты:\n${digestText(dayOf(Date.now()), d).split('\n').slice(1).join('\n')}` : ''}`);
} else {
  const started = Date.now();
  for (;;) {
    const t = Date.now();
    try {
      await round();
    } catch (err) {
      // Ошибка одной проверки не должна останавливать сторожа на остаток запуска
      console.log(`${msk()} ошибка проверки: ${err.stack ?? err}`);
      save();
    }
    const wait = EVERY_MS - (Date.now() - t);
    if (Date.now() - started + Math.max(wait, 0) >= RUN_MS) break;
    if (wait > 0) await sleep(wait);
  }
}
