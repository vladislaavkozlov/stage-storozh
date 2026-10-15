// Проверка прода Stage и сигнал в Telegram (15.10.2026).
// Прод считается лежащим, только если не ответил три раза подряд с паузой 20 секунд:
// разовая ошибка сети не должна будить человека. Пока лежит - напоминание раз в 30
// минут, когда ожил - одно сообщение «снова работает»
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const URL = process.env.STOROZH_URL ?? 'https://app.vladkozlovdigital.ru/health';
const TRIES = 3;
const PAUSE_MS = Number(process.env.STOROZH_PAUSE_MS ?? 20_000);
const REMIND_MS = 30 * 60_000;
const STATE = 'state/state.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msk = (d = new Date()) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

async function check() {
  let last = '';
  for (let i = 0; i < TRIES; i += 1) {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(15_000) });
      const body = await res.text();
      if (res.status === 200 && body.includes('"ok":true')) return { up: true };
      last = `ответ ${res.status}`;
    } catch (err) {
      last = err.name === 'TimeoutError' ? 'нет ответа 15 секунд' : `ошибка сети (${err.cause?.code ?? err.message})`;
    }
    if (i < TRIES - 1) await sleep(PAUSE_MS);
  }
  return { up: false, why: last };
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

const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { down: false };
const now = Date.now();
const r = await check();
let next = prev;

if (r.up && prev.down) {
  const minutes = Math.round((now - prev.since) / 60_000);
  await tell(`✅ Прод Stage снова работает (${msk()} МСК). Не отвечал около ${minutes} мин`);
  next = { down: false };
} else if (!r.up && !prev.down) {
  await tell(`🔴 Прод Stage не отвечает (${msk()} МСК): ${r.why}.\n${URL}\nКабинеты клиентов сейчас не работают. Первым делом проверь базу proddb в панели Amvera`);
  next = { down: true, since: now, reminded: now };
} else if (!r.up && prev.down && now - prev.reminded >= REMIND_MS) {
  const minutes = Math.round((now - prev.since) / 60_000);
  await tell(`🔴 Прод Stage всё ещё не отвечает: ${minutes} мин (${r.why})`);
  next = { ...prev, reminded: now };
}

mkdirSync('state', { recursive: true });
writeFileSync(STATE, JSON.stringify(next));
console.log(r.up ? 'прод отвечает' : `прод не отвечает: ${r.why}`, JSON.stringify(next));
