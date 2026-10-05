# Jiraffe — публичный релиз (Marketplace + Open VSX)

> Статус: этапы 1–2 приняты 2026-10-05 (ждёт пользователя: проверка UI в VS Code на en и ru) · этап 3 — ждёт решений пользователя (лицензия, публичный репо).
> Исполнитель отмечает чекбоксы `- [x]` только после проверки. Приёмка этапа (Opus, `/plan-review`) меняет статус и коммитит.

## Цель

Расширение публикуется в VS Code Marketplace и Open VSX: UI на английском по умолчанию и на русском
при русском языке VS Code, английский README со скриншотами (обезличенный английский прототип),
метаданные и лицензия под стор, репозиторий без внутренних данных работодателей.

## Контекст

- Версия 0.2.0 выпущена GitHub Release (репо приватный). README.md английский, README.ru.md русский.
- Коммиты на русском, формат `Область: что`, без подписей ассистента. Ветка на этап + `merge --no-ff`.
- Проверки: `npm run lint`, `npm test`, `npm run build`, `npm run package`.

## Этапы

### Этап 1 — локализация (sonnet, high)
- [x] `src/l10n.ts`: `t`, `tn`, `setL10n`, `locale`; бандл в хосте и webview
- [x] Все UI-строки хоста и webview через `t`/`tn`, `package.json` через `%key%` + `package.nls*.json`
- [x] `l10n/bundle.l10n.ru.json` полный; тесты на английский + `test/l10n.test.ts`
- [x] `.vscodeignore` пропускает `l10n/**` и `package.nls*.json`; `npm run package` их содержит

Готово, когда: DoD промта 1.

Решения (2026-10-05, приёмка этапа 1):
- Константы с подписями стали функциями (`maybeSaved()`, `addButton()`, `cancelled()`, `tabLabel()`, `modeLabel`), `STATUS_LABEL`/`CATEGORY_LABEL` — объекты с геттерами: иначе t() на верхнем уровне модуля отдал бы английский до `setL10n`.
- `getBundle()` в `src/l10n.ts` — хост передаёт бандл в каркас webview.
- Ключ `yes` с двумя переводами разведён: `available` («есть») в `commands/instances.ts`, `yes` («да») в карточке.
- `{0} file(s)` переделан на `tn` при приёмке.
- Принято как есть: заголовки `it`/`describe` в тестах русские; русская подсказка логирования «Потрачено: 1ч 30м · 1h30m…» (parseDuration понимает оба); заголовки команд в `src/views` без префикса «Jiraffe:».

### Этап 2 — английский прототип и скриншоты (sonnet, high; после этапа 1)
- [x] `prototype/index.en.html` — английский, обезличенный, строки UI = английские строки расширения
- [x] Оверлей смены статуса (QuickPick) и починенная иконка инстанса в квик-фильтрах
- [x] `scripts/screenshots.mjs` + `npm run screenshots` → `docs/screenshots/*.png`
- [x] README.md: новые скриншоты, строка про языки UI

Готово, когда: DoD промта 2.

Решения (2026-10-05, приёмка этапа 2):
- Прототип подогнан под расширение: из раздела Tempo убраны недельный график и кнопка «Week» (вместо — Refresh/Log), клик по Tempo в строке состояния раскрывает раздел; в шапку карточки добавлен Pin, на вкладки эпика/релиза — Refresh; статус Cancelled — пятый в данных.
- Починены баги оригинала: пустой прямоугольник скрытого тоста.
- Поле даты в Log Work рисуется в локали ОС (02.10.2026) — нативный `<input type=date>`, как и в реальном webview; оставлено.

### Этап 3 — метаданные, гигиена репо, публикация (opus, сам; после ответов пользователя)
- [ ] LICENSE + `license`, `publisher: "fosteev"` (паблишер создан пользователем 2026-10-05; ID расширения станет `fosteev.jiraffe` — инстансы и токены из `jiraffe.jiraffe` не переедут), убрать `private`; `description`/`keywords`/`galleryBanner`/`homepage`/`bugs`
- [ ] CHANGELOG на английском
- [ ] `ovsx` в devDependencies, скрипты `publish:vsce` / `publish:ovsx`
- [ ] Гигиена: русский прототип, `roadmap-*.md`, `scripts/smoke.ts` (хосты работодателей, customfield, env) — убрать/обезличить; публичный репо — по решению (чистая история или как есть)
- [ ] Публикация — только по подтверждению пользователя, его токенами

## Промты

### Промт 1

```
Сессия 1 — локализация Jiraffe · Модель: sonnet, effort: high

Работаем в /Users/fost/Projects/jiraffe (VS Code extension, TypeScript, esbuild, vitest). Задача: весь UI
расширения на английском по умолчанию и на русском, если VS Code на русском. Сейчас все строки UI — русские
литералы в коде.

Читай: roadmap-public.md (этот файл, этап 1). Коммиты — не делаешь.
Точки входа:
- src/panels/html.ts:20 renderShell — каркас webview (html lang="ru", «Загрузка…»); вызывается в
  src/panels/issuePanel.ts:177, src/panels/listPanel.ts:72, src/views/tempoView.ts:33.
- src/extension.ts activate — место инициализации.
- src/state/filters.ts:56 plural(n, one, few, many) — русский плюрализатор (3 вызова).
- src/duration.ts:49 formatDuration → `1ч 30м`.
- 'ru-RU' в webview/render.ts:71,76,81,172 и webview/today.ts:12.
- Webview-входы webview/issue.ts, webview/list.ts, webview/tempo.ts импортируют модули из ../src.
- Больше всего строк: webview/render.ts, package.json, src/commands/instances.ts, src/jira/http.ts,
  src/commands/filters.ts, src/commands/logWork.ts, src/panels/attachments.ts, src/views/*Tree.ts.
Найти все: `grep -rnP "[А-Яа-яЁё]" src webview package.json` (LC_ALL=en_US.UTF-8).

Уже решено, не переспрашивать:
1. Свой модуль src/l10n.ts без импорта vscode (тестируется и работает в webview):
   - `setL10n(bundle: Record<string,string> | undefined, locale: string)`;
   - `t(message: string, ...args: (string|number)[]): string` — `bundle?.[message] ?? message`, затем `{0}`,`{1}`… → args;
   - `tn(n: number, forms: string, ...args)` — forms это английский ключ вида `'{0} issue|{0} issues'`;
     перевод из бандла (ru: `'{0} задача|{0} задачи|{0} задач'`) делится по `|`, форма выбирается через
     `new Intl.PluralRules(locale()).select(n)`: en — one→0, иначе 1; ru — one→0, few→1, many/other→2.
     `{0}` в tn — это n, остальные args — `{1}`…;
   - `locale(): string` — для toLocale*/Intl.
   Ключ бандла = английский текст. vscode.l10n.t НЕ используем (один механизм на хост и webview).
2. Хост: в начале activate — `setL10n(vscode.l10n.bundle, vscode.l10n.bundle ? vscode.env.language : 'en')`.
   В package.json `"l10n": "./l10n"`; русский бандл — l10n/bundle.l10n.ru.json. Английского бандла нет.
3. Webview: ShellOptions получает `l10n: { bundle?: Record<string,string>; locale: string }`; renderShell
   кладёт `<script type="application/json" id="jiraffe-l10n">…</script>` (JSON с `<` → `<`), `lang` = locale,
   «Загрузка…» → t('Loading…'). Хост берёт бандл и локаль из src/l10n.ts (экспортируй геттер). Новый
   webview/l10nInit.ts читает этот тег и зовёт setL10n; каждый webview-вход импортирует его ПЕРВЫМ импортом.
4. t()/tn() — только внутри функций. Никаких t() на верхнем уровне модулей (константы с подписями → функции
   или Record с ключами, переводимый при отрисовке): модуль импортируется раньше setL10n и получит английский.
5. package.json: все title/name/description/placeholder/markdownDescription/enumDescriptions вида `%command.addInstance%`
   и т.п.; английский — package.nls.json, русский — package.nls.ru.json (текущие строки). Сюда же
   `capabilities.untrustedWorkspaces.description` и `description` расширения. displayName — "Jiraffe" как есть.
6. formatDuration: t('{0}m'), t('{0}h'), t('{0}h {1}m'); ru — `{0}м`, `{0}ч`, `{0}ч {1}м`. parseDuration
   НЕ трогать (понимает и ч/м, и h/m). plural() из state/filters.ts заменить на tn и удалить.
7. 'ru-RU' → locale(). Числа (numberRu) — тоже через locale().
8. НЕ переводить строки, которые уходят в Jira или сравниваются с данными Jira: JQL, имена полей, регэкспы
   по названиям типов/статусов/приоритетов (src/jira/epics.ts:17,112-114 — эталон «не трогать»), единицы
   в parseDuration, атрибут Tempo «AI Tokens». Не уверен — оставь как есть и перечисли в отчёте.
   Комментарии в коде остаются на русском.
9. Английский — короткий, в стиле VS Code. Заголовки команд — Title Case, остальное — sentence case.
   Глоссарий (обязателен, на нём строится этап 2): Задачи→Issues, Фильтры→Filters, Эпики→Epics,
   Релизы→Releases, Tempo→Tempo, инстанс→instance, На мне→Assigned to Me, Проект→Project, JQL→JQL,
   быстрые фильтры→Quick Filters, Мои→My Filters, Избранные в Jira→Jira Favorites, Описание→Description,
   Вложения→Attachments, Комментарии→Comments, История→History, Журнал работ→Work Log,
   Залогать время→Log Work, Сменить статус→Change Status, Открыть в Jira→Open in Jira,
   Скопировать ключ→Copy Key, Закрепить→Pin, Обновить→Refresh, Загрузить ещё→Load More,
   Сегодня→Today, Скачать→Download, Скачать все→Download All, Открыть в редакторе→Open in Editor,
   Добавить инстанс→Add Instance, Проверить подключение→Test Connection, Удалить инстанс→Remove Instance,
   Инстансы этого workspace→Workspace Instances, Открыта/В работе/Готово→To Do/In Progress/Done,
   [картинка]→[image], [внешняя картинка]→[external image].
10. Тесты (test/*.ts) переписать на английские ожидания (бандл не установлен). Новый test/l10n.test.ts:
   - сканирует src/** и webview/** на литералы `t('…')`, `t("…")`, `tn(x, '…')` (шаблонные строки без `${`
     тоже) — каждый ключ есть в l10n/bundle.l10n.ru.json, и в бандле нет ключей, которых нет в коде;
   - множества плейсхолдеров `{N}` ключа и перевода совпадают; у tn-ключей 2 формы, у перевода 3;
   - package.nls.json и package.nls.ru.json — одинаковые ключи; каждый `%key%` из package.json есть в nls;
   - с русским бандлом: formatDuration(5400) === '1ч 30м', tn(5, …) даёт форму many, tn(2, …) — few.
   В конце теста setL10n(undefined, 'en').
11. .vscodeignore (белый список): добавить `!l10n/**` и `!package.nls*.json`.

Порядок:
1. src/l10n.ts + test/l10n.test.ts (каркас) + html.ts/l10nInit.ts + activate.
2. package.json → nls-файлы.
3. Файлы по одному: строки → t/tn, русское → бандл. После каждого 2–3 файлов — `npm test` и `npm run lint`.
4. Тесты на английский, `npm run package`, `unzip -l jiraffe-0.2.0.vsix | grep -E "l10n|nls"`.
Галочки этапа 1 в roadmap-public.md — по факту проверки.

DoD:
- `npm run lint && npm test && npm run build` — зелёные (вывод в файл, в контекст tail).
- `LC_ALL=en_US.UTF-8 grep -rnP "[А-Яа-яЁё]" src webview --include=*.ts | grep -vP '^\S+:\d+:\s*(//|\*|/\*)'`
  — остались только строки из пункта 8 и хвостовые комментарии; список — в отчёт.
- `LC_ALL=en_US.UTF-8 grep -cP "[А-Яа-яЁё]" package.json` → 0.
- `npm run package` и в .vsix есть l10n/bundle.l10n.ru.json, package.nls.json, package.nls.ru.json.

Не делать: менять поведение, протокол сообщений (кроме l10n в каркасе), CSP, версию, README, CHANGELOG,
prototype/; переименовывать команды/настройки (id остаются); «заодно улучшить» — нет; новые зависимости — нет.
Вопрос без ответа в промте — в отчёт, не додумывать.

Не коммитить, не пушить — это сделает приёмка.
Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / оставшаяся кириллица (пункт 8) /
не проверено / открытые вопросы. Отчёт — единственное, что увидит приёмка.
```

### Промт 2

```
Сессия 2 — английский прототип и скриншоты · Модель: sonnet, effort: high · после приёмки сессии 1

Работаем в /Users/fost/Projects/jiraffe. Задача: английская обезличенная копия кликабельного прототипа
и воспроизводимый скрипт скриншотов для README.

Читай: roadmap-public.md (этап 2). Английские строки расширения — ключи l10n/bundle.l10n.ru.json и
package.nls.json: в прототипе подписи UI должны совпадать с ними дословно.
Точки входа:
- prototype/index.html (868 строк, один IIFE-скрипт с 317 по 867 строку; состояние S ~строка 504,
  openTab ~799, таблица действий A ~804, оверлеи showOv/closeOv ~754, qpHtml — квик-фильтры,
  logHtml — диалог логирования). Тема: `document.documentElement.dataset.theme = 'dark'`.
- docs/screenshots/ — текущие 5 картинок (card, attachments, log-work, epic, release) — заменить.

Уже решено, не переспрашивать:
1. Новый файл prototype/index.en.html (копия index.html); index.html не трогать.
2. Обезличивание (во всём файле, включая данные, имена файлов и id): jira.pilot-gps.com→jira.northwind.io,
   jira.sccloud.ru→jira.globex.dev, atlassian.tatikoma.ru/jira→tracker.initech.net/jira, Pilot→Northwind,
   SmartCityCloud→Globex, Tatikoma→Initech, pilot/sccloud/tatikoma (id)→northwind/globex/initech,
   GARM→HOME, P7→TRK, NEWMFC→CRM, RPGU→PORT, VBV→OPS, SDU→DESK, Ivideon/ivideon→CamCloud/camcloud,
   Pulse/pulse→Orbit/orbit, МФЦ→Support. Итог: `grep -ciE "pilot|sccloud|tatikoma|garm|newmfc|ivideon|pulse"
   prototype/index.en.html` → 0.
3. Всё на английском: UI-подписи (по бандлу), данные (заголовки задач, описания, комментарии, история,
   фильтры, ворклоги — правдоподобный английский про умный дом/камеры/CRM), люди — английские имена
   (Andrew Foster вместо «Андрей Фостеев» и т.д.), даты — формат en (Oct 2, 2026), длительности 1h 30m,
   `lang="en"`. Шапку прототипа над окном — тоже на английском.
4. Чего нет в расширении — не добавлять на скриншоты: недельной вкладки Tempo («Tempo · week») и модалки
   «добавить инстанс» в кадрах нет (в файле могут остаться).
5. Смена статуса: клик по статусу в шапке карточки открывает оверлей в стиле VS Code QuickPick (переиспользуй
   классы квик-фильтров .qp-*): заголовок «Change Status · HOME-710», пункты «→ In Review», «→ Done»,
   «→ Cancelled» с категорией справа; выбор — тост и смена статуса задачи.
6. Квик-фильтры: в оверлее иконка инстанса раздута на пол-экрана — ограничить размер svg (16px).
7. В конце IIFE: `window.__proto = { S, A, openTab, render, showOv, closeOv, logHtml, qpHtml, cur, TODAY }`.
8. scripts/screenshots.mjs (ESM) + devDependency playwright-core + скрипт `"screenshots": "node scripts/screenshots.mjs"`.
   Chrome: `process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`.
   viewport 1360×820, deviceScaleFactor 2, dark; каждый кадр — свежая загрузка file:// prototype/index.en.html,
   снимок элемента `#win` в docs/screenshots/<name>.png. Кадры:
   card (карточка HOME-710, «Description»), filters (раздел Issues в режиме JQL с открытым оверлеем Quick Filters),
   attachments (вкладка Attachments), log-work (диалог Log Work), change-status (оверлей п.5),
   epic (вкладка эпика HOME-600), release (вкладка релиза v214), tempo (раскрытый раздел Tempo в сайдбаре
   со сводкой Today, остальные разделы свёрнуты; строка состояния видна). pageerror → скрипт падает.
9. README.md: убрать строку «The UI is in Russian for now…», вместо неё «The UI follows the VS Code display
   language: English or Russian.» и ссылка на README.ru.md; добавить кадры filters, change-status, tempo
   рядом с соответствующими абзацами; тексты абзацев не раздувать, новых разделов не добавлять.

Порядок: обезличивание → перевод → оверлей статуса и иконка → __proto → скрипт → `npm run screenshots` →
README. Каждый кадр проверить, открыв PNG (Read), — один раз, после финального прогона, можно контакт-листом.

DoD: `npm run screenshots` отрабатывает без ошибок и пишет 8 PNG; grep из п.2 → 0;
`LC_ALL=en_US.UTF-8 grep -cP "[А-Яа-яЁё]" prototype/index.en.html` → 0; `npm run lint && npm test` зелёные;
`unzip -l` свежего `npm run package` не содержит docs/ и prototype/.

Не делать: prototype/index.html, код расширения, CHANGELOG, package.json (кроме devDependency и скрипта).
Не коммитить, не пушить. Отчёт последним сообщением: сделано / отклонения / не проверено / вопросы.
```
