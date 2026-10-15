# Сторож прода Stage

Раз в 5 минут проверяет `https://app.vladkozlovdigital.ru/health` и пишет в Telegram, если прод не отвечает три раза подряд. Пока лежит - напоминает раз в 30 минут, когда ожил - сообщает.

Работает на GitHub Actions, вне Amvera. Ключ бота и чат - в секретах репозитория `TG_TOKEN` и `TG_CHAT_ID`.

Проверить вручную: вкладка Actions → storozh-proda → Run workflow.
