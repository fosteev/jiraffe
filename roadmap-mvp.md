# Jiraffe MVP — расширение VS Code для Jira

> Статус: этап 1 принят 2026-10-04 · следующий — этап 2 (сессия 2)
> Исполнитель отмечает чекбоксы `- [x]` по ходу работы — только после проверки, не «вроде сделал».
> Приёмка этапа (Opus, `/plan-review`) меняет баннер этапа и коммитит.

## Цель

Установленное из `.vsix` расширение Jiraffe позволяет, не открывая браузер, работать с тремя
рабочими Jira (Pilot, SmartCityCloud, Tatikoma) и личной Cloud. Через него можно найти свои задачи
и задачи проекта (с фильтрами и JQL), прочитать задачу целиком (описание, вложения, комментарии,
история, журнал работ), залогать время (через Tempo там, где он есть) и посмотреть эпики и релизы.

## Контекст и ограничения

- Функции MVP — `README.md` (разделы 1–8). Чего нет в README, в MVP не делаем.
- Эталон UI — `prototype/index.html` (кликабельный, опубликован:
  https://claude.ai/artifact/U6kZj1Mu3xUEntAWCH9rdw). Разметку и CSS карточки, эпика и релиза
  переносим оттуда, а цветовые токены прототипа заменяем на `--vscode-*`.
- Репо пустое: есть README, прототип и этот файл. Коммиты на русском, формат `Область: что`
  (см. `git log`), без подписей ассистента.
- **Факты об инстансах** (из рабочих скриптов `~/.claude/skills/{pilot,sccloud,tatikoma,troy}-jira/jira.sh`):

  | Инстанс | Тип | Auth | Особенности |
  |---|---|---|---|
  | jira.pilot-gps.com | DC | Bearer PAT (`JIRA_PILOT_TOKEN`) | **Tempo есть**, работает только REST v3 `/rest/tempo-timesheets/3/worklogs/` (v4 → 404); в POST обязателен `issue.remainingEstimateSeconds`; атрибуты — `worklogAttributes:[{key,value}]`, AI Tokens = `_AITokensUsed_`; список атрибутов — `/rest/tempo-core/1/work-attribute`; Epic Link = `customfield_10100`; автор worklog — `{name: <login из /myself>}` |
  | jira.sccloud.ru | Server 9.12 | Bearer PAT (`JIRA_SCCLOUD_TOKEN`) | **Tempo нет** → `/rest/api/2/issue/{key}/worklog?adjustEstimate=leave`; AI Tokens дописываются в комментарий `(AI Tokens: N)`; Epic Link = `customfield_10102` |
  | atlassian.tatikoma.ru/jira | Server 8.22, context path `/jira` | Bearer PAT (`JIRA_TATIKOMA_TOKEN`) | **Tempo нет** (так же, как sccloud); Epic Link = `customfield_10102` |
  | fosteev.atlassian.net | Cloud | Basic `email:token` (`JIRA_CLOUD_EMAIL`, `JIRA_CLOUD_TOKEN`) | `/rest/api/2/search` выпилен → `/rest/api/2/search/jql` (курсор `nextPageToken`); проект team-managed: эпик — это `parent`, Epic Link нет; пользователи по `accountId` |

  URL инстансов лежат в env `JIRA_*_URL`, дефолты указаны в скриптах.
- **Принятые решения:**
  - Карточка задачи — webview-вкладка редактора в режиме preview: новая задача открывается
    в той же вкладке, пока её не закрепили кнопкой «Закрепить» в шапке карточки. Закреплённая
    вкладка живёт отдельно.
  - Атрибуты Tempo не зашиваем в код: берём с инстанса через `/rest/tempo-core/1/work-attribute`
    и рисуем поля формы по их описанию. Поле AI Tokens показывается на всех инстансах. Без Tempo
    его значение уходит в комментарий, как в скриптах.
  - Наличие Tempo определяем автоматически: `GET /rest/tempo-core/1/work-attribute` → 200 значит
    «Tempo есть», 404 — «нет». Результат кэшируется на инстанс, есть команда «Обновить
    возможности инстанса».
  - Поле Epic Link на DC ищем через `/rest/api/2/field` (`schema.custom ==
    "com.pyxis.greenhopper.jira:gh-epic-link"`), найденное значение можно переопределить в
    настройках инстанса. На Cloud эпик берём из `parent`.
  - Быстрый фильтр по статусу работает по `statusCategory` (Открыта / В работе / Готово), потому
    что набор статусов у каждого проекта свой. Типы и приоритеты подгружаются с инстанса.
  - Быстрые фильтры и текст поиска превращаются в JQL и уходят на сервер. Клиентская фильтрация
    списка — только в прототипе.
  - Сводка Tempo в MVP — только «сегодня» (боковая панель и строка состояния). Неделю по всем
    инстансам делаем после MVP.
  - Вложения сохраняются в `<workspace>/.jiraffe/<KEY>/`, без открытой папки — во временный
    каталог. Путь задаётся настройкой `jiraffe.attachmentsDir`.
  - Описание (`renderedFields`) санитизируется на стороне расширения (`sanitize-html`).
    Картинки из описания и превью вложений скачиваются расширением с авторизацией и попадают в
    webview как `data:` URI. У webview строгий CSP: скрипты только с nonce.
  - Webview — ванильный TS (как прототип), без React. Бандлится esbuild отдельно от хоста.
  - Тесты — vitest для чистых модулей и клиента API (с моком `fetch`). Плюс `npm run smoke` —
    **только чтение** по живым инстансам из env-переменных. Запись в живые Jira проверяет
    пользователь.
- **Допущения** (проверить на своём этапе):
  - Чтение ворклогов Tempo v3: `GET /rest/tempo-timesheets/3/worklogs?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&username=<login>`
    (и/или `&projectKey=` / `&issue=`). Не проверено. Если endpoint не отвечает, атрибуты
    в журнале задачи не показываем, а сводку «сегодня» строим через стандартный путь (этап 6).
  - JQL `issuetype = Epic` находит эпики на русских инстансах. Если нет, ищем по id типа
    из `/rest/api/2/issuetype`.
  - Ворклоги Tempo Server видны в стандартном `/rest/api/2/issue/{key}/worklog`.
  - Формат описаний рабочих атрибутов (`type`: `INPUT_FIELD`, `STATIC_LIST`, …) уточнить по
    живому ответу на этапе 6.

## Архитектура и контракты

Раскладка файлов, на которую ссылаются промты. Новые файлы вне этого списка — только по
необходимости, с упоминанием в отчёте.

```
package.json              contributes: viewsContainers.activitybar "jiraffe", views, commands, menus, configuration
tsconfig.json, esbuild.mjs (два бандла: dist/extension.js — node/cjs, dist/webview/*.js — browser/iife)
eslint.config.mjs, vitest.config.ts, .gitignore, .vscodeignore
media/jiraffe.svg         иконка activity bar (жираф из прототипа, IC.giraffe)
src/extension.ts          activate(): собирает сервисы, регистрирует провайдеры и команды
src/jira/types.ts         доменные типы (ниже)
src/jira/http.ts          HttpClient: baseUrl (с context path) + path, auth-заголовок, JSON, JiraError
src/jira/client.ts        JiraClient — все REST-вызовы Jira
src/jira/capabilities.ts  detectCapabilities(): tempo, epicLinkField, serverInfo
src/jira/mappers.ts       raw JSON → доменные типы
src/jira/tempo.ts         TempoClient (v3): attributes, worklogs, addWorklog
src/state/instances.ts    InstanceStore: globalState (настройки) + SecretStorage (токены)
src/state/filters.ts      FilterState: режим, быстрые фильтры, текст, локальные сохранённые фильтры
src/jql.ts                buildJql(...)
src/duration.ts           parseDuration / formatDuration
src/views/issuesTree.ts   TreeDataProvider «Задачи»
src/views/filtersTree.ts  «Фильтры»
src/views/epicsTree.ts    «Эпики»
src/views/releasesTree.ts «Релизы»
src/views/tempoView.ts    WebviewViewProvider «Tempo»
src/views/statusBar.ts    элемент строки состояния
src/panels/issuePanel.ts  IssuePanelManager (preview + закреплённые)
src/panels/listPanel.ts   EpicPanel / ReleasePanel
src/panels/html.ts        общий HTML-каркас webview: CSP, nonce, подключение css/js
src/panels/protocol.ts    типы сообщений host ↔ webview
webview/issue.ts, webview/list.ts, webview/common.css   код и стили webview
scripts/smoke.ts          read-only smoke по env, запуск `npm run smoke`
test/*.test.ts
```

Доменные типы (`src/jira/types.ts`):

```ts
export type InstanceKind = 'dc' | 'cloud';
export interface Instance { id: string; name: string; baseUrl: string; kind: InstanceKind; email?: string;
  epicLinkField?: string; caps?: Capabilities }            // токен — только в SecretStorage под ключом `jiraffe.token.<id>`
export interface Capabilities { tempo: boolean; epicLinkField: string | null; checkedAt: string; serverVersion?: string }
export interface UserRef { id: string; name: string; avatarUrl?: string }   // id = name (DC) | accountId (Cloud)
export type StatusCategory = 'new' | 'indeterminate' | 'done';
export interface IssueSummary { instanceId: string; key: string; summary: string; type: string; typeIconUrl?: string;
  status: string; statusCategory: StatusCategory; priority?: string; assignee?: UserRef; updated: string }
export interface IssueDetail extends IssueSummary { reporter?: UserRef; watchers: UserRef[]; descriptionHtml: string;
  epic?: { key: string; summary?: string }; fixVersions: { id: string; name: string }[]; labels: string[]; components: string[];
  created: string; due?: string; timetracking: { originalSec?: number; remainingSec?: number; spentSec?: number };
  attachments: Attachment[]; comments: Comment[]; history: HistoryEntry[] }
export interface Attachment { id: string; filename: string; size: number; mimeType: string; author?: UserRef; created: string;
  contentUrl: string; thumbnailUrl?: string }
export interface Comment { id: string; author?: UserRef; created: string; bodyHtml: string }
export interface HistoryEntry { author?: UserRef; created: string; items: { field: string; from: string | null; to: string | null }[] }
export interface Worklog { id: string; author?: UserRef; started: string; timeSpentSec: number; comment: string;
  attributes?: Record<string, string> }
export interface SearchPage { issues: IssueSummary[]; next?: { startAt?: number; nextPageToken?: string }; total?: number }
```

Команды (`jiraffe.*`): `addInstance`, `removeInstance`, `testConnection`, `refreshCapabilities`,
`refresh`, `setMode` (mine | project | jql), `pickProject`, `quickFilters`, `editJql`, `saveFilter`,
`deleteFilter`, `search`, `openIssue`, `openIssueByKey`, `pinIssue`, `openInBrowser`, `copyKey`,
`logWork`, `downloadAttachment`, `openEpic`, `openRelease`. Настройки: `jiraffe.maxResults` (50),
`jiraffe.attachmentsDir` (`.jiraffe`), `jiraffe.workdayHours` (8), `jiraffe.maxImageMb` (5).

## Этапы

### 1. Каркас расширения
Пустое, но собирающееся расширение: контейнер в activity bar, пять пустых views, сборка, линт,
тесты, упаковка в `.vsix`.

- [x] `package.json`: name `jiraffe`, `engines.vscode ^1.90.0`, `main: dist/extension.js`, скрипты `build`, `watch`, `lint`, `test`, `package` (`vsce package --no-dependencies`), `smoke`
- [x] devDeps: `typescript`, `esbuild`, `@types/vscode@1.90`, `@types/node@20`, `vitest`, `eslint`, `typescript-eslint`, `@vscode/vsce`, `tsx`
- [x] `tsconfig.json` (strict, ES2022), `esbuild.mjs` с двумя бандлами (host — cjs/node, webview — iife/browser), `vitest.config.ts`, `eslint.config.mjs`
- [x] `.gitignore` (`node_modules`, `dist`, `*.vsix`, `.jiraffe`), `.vscodeignore`
- [x] `media/jiraffe.svg`; `contributes.viewsContainers.activitybar` `jiraffe` и views `jiraffe.issues`, `jiraffe.filters`, `jiraffe.epics`, `jiraffe.releases`, `jiraffe.tempo` (последний — `type: webview`)
- [x] `src/extension.ts`: `activate` регистрирует заглушки провайдеров и команду `jiraffe.refresh`
- [x] `src/duration.ts` + `test/duration.test.ts`: `parseDuration` понимает `1ч 30м`, `1h30m`, `90m`, `1.5h`, `2` (часы), `45 мин`; мусор → `null`; `formatDuration(5400) === '1ч 30м'`
- [x] `.vscode/launch.json` (Run Extension) и `.vscode/tasks.json` (watch)

**Готово, когда:** `npm run build && npm run lint && npm test && npm run package` проходят,
`jiraffe-0.0.1.vsix` собирается. По F5 в activity bar появляется иконка жирафа и пять разделов
(проверяет пользователь).

**Сессия:** sonnet, high; первым, остальные этапы от него зависят.

**Решения (2026-10-04, по итогам сессии 1):**
- Раскладка — как в «Архитектуре»: `package.json`, `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `.vscodeignore`, `media/jiraffe.svg` (IC.giraffe из прототипа, `currentColor`), `src/extension.ts`, `src/duration.ts`, `test/duration.test.ts`, `webview/issue.ts` (пустая заглушка, чтобы собирался второй бандл), `scripts/smoke.ts` (заглушка: печатает «не реализован», настоящий smoke — этап 2), `.vscode/{launch,tasks}.json`. Вне списка добавлен только `package-lock.json` (нужен для воспроизводимой установки).
- `vitest@3`, а не последний 5: vitest 5 требует `@types/node >=22`, а мы зафиксированы на `@types/node@20` (ограничение roadmap). `@types/vscode` запинен как `1.90.0` (без `^`, чтобы не обогнать `engines.vscode`). Из версий остальное — latest (TypeScript 6, ESLint 10, esbuild 0.28, vsce 4).
- Пакет `@eslint/js` не добавлял (вне списка devDeps): конфиг — `typescript-eslint` `configs.recommended` + `no-unused-vars` с игнором `_args`. `npm run lint` = `tsc --noEmit && eslint .` (типы проверяются тоже).
- Единый `tsconfig.json` (`lib: ES2022 + DOM`, `types: node, vscode`) на хост и webview; включены `src`, `webview`, `test`, `scripts`, корневые `*.ts`. Если на этапе 4 DOM-типы в хосте начнут мешать, разнести на два tsconfig.
- `package.json`: `publisher: "jiraffe"` (vsce требует), `private: true`, `license: "UNLICENSED"`, `activationEvents: []` (views активируют расширение сами, VS Code ≥1.74). Команда `jiraffe.refresh` показывает info-сообщение «пока нечего обновлять». Views «Задачи/Фильтры/Эпики/Релизы» — пустые `TreeDataProvider`, `jiraffe.tempo` — `WebviewViewProvider` с текстом «Tempo: скоро». Без `viewsWelcome`: пока нет данных, пустые деревья показывают голое пустое место — приёмка/пользователь решают, нужна ли welcome-подсказка до этапа 2.
- `parseDuration`: голое число — часы только если это весь ввод (`2`, `0.5`; `1 30` → null); разделители десятых `.` и `,`; регистр не важен; единицы h/hr/hrs/hour(s), m/min(s)/minute(s), ч/час/часа/часов, м/мин/минут(а/ы). Ноль (`0`, `0м`) → `null` (логировать нулевое время бессмысленно) — это поведение, которое может пересмотреть этап 6. *Приёмка:* результат округляется до целых минут (`0.01h` → 60, меньше полуминуты → `null`), потолок 10 000 ч (больше → `null`), после единицы допустима точка (`1 ч. 30 мин.`), добавлено `минуту`. `formatDuration` округляет секунды до минут, `0` → `0м`, целые часы — `2ч` без `0м`.
- `.vscodeignore` — белый список (`**` + разрешённые). Карты (`*.map`) в `.vsix` не попадают; шаблон `!dist/webview/*.js` и `*.css` — если на этапе 4 в `dist/webview/` появятся другие типы файлов, дописать.
- `esbuild.mjs`: в обычном режиме minify, в `--watch` — нет; sourcemap всегда. Строка `watching…` в watch-режиме нужна problemMatcher в `.vscode/tasks.json`.
- `vsce package` предупреждает об отсутствии LICENSE — оставлено (команда зафиксирована в плане без `--skip-license`). *Приёмка:* `repository` добавлен (`https://github.com/fosteev/jiraffe.git`).
- *Приёмка:* в `.vscode/tasks.json` background-паттерны были `watching`/`watching` — на пересборке esbuild пишет `[watch] build started` / `[watch] build finished`, и задача не отслеживала пересборки. Теперь begin = `\[watch\] build started`, end = `^watching|\[watch\] build finished` (строки проверены на живом `npm run watch`).

**Приёмка (2026-10-04, Opus):** принят. Проверено: `npm run build && npm run lint && npm test && npm run package` — зелёные; 45 тестов duration (29 исполнителя + граничные случаи приёмки); `jiraffe-0.0.1.vsix` (7 файлов: manifest, package.json, readme, dist/extension.js, dist/webview/issue.js, media/jiraffe.svg). **Не проверено:** F5 в Extension Development Host (иконка и пять разделов) и работа `.vscode/tasks.json` watch — пользователь.

### 2. Инстансы, авторизация и клиент API
Слой данных без UI-списков: хранение инстансов, авторизация DC и Cloud, HTTP-клиент с ошибками,
поиск с пагинацией, определение возможностей инстанса.

- [ ] `src/jira/types.ts` — типы из раздела «Архитектура» дословно
- [ ] `src/jira/http.ts`: DC → `Authorization: Bearer <token>`, Cloud → `Basic base64(email:token)`; `baseUrl` может содержать context path (`https://host/jira`); `JiraError { status, message, url }`; сообщения для 401/403/404/сети на русском
- [ ] `src/jira/client.ts`: `myself`, `search(jql, fields, page)` (DC — `GET /rest/api/2/search?startAt=`, Cloud — `GET /rest/api/2/search/jql?nextPageToken=`), `issue(key, expand)`, `fields`, `projects`, `issueTypes`, `priorities`, `favouriteFilters` (`/rest/api/2/filter/favourite`)
- [ ] `src/jira/mappers.ts`: raw → `IssueSummary`/`UserRef` (DC: `name`; Cloud: `accountId`)
- [ ] `src/jira/capabilities.ts`: Tempo по `/rest/tempo-core/1/work-attribute` (200/404), Epic Link по `/rest/api/2/field`, `serverInfo` → версия
- [ ] `src/state/instances.ts`: CRUD в `globalState` под `jiraffe.instances`, токены в `SecretStorage`; `id` = slug хоста
- [ ] Команда `jiraffe.addInstance` — многошаговый QuickInput (URL → тип DC/Cloud → email для Cloud → токен → проверка `/myself` → имя), плюс `removeInstance`, `testConnection`, `refreshCapabilities`
- [ ] `test/http.test.ts`, `test/client.test.ts` с моком `fetch`: заголовки обоих типов, context path, пагинация DC и Cloud, маппинг 401
- [ ] `scripts/smoke.ts`: для каждого инстанса с заданным в env токеном — `myself`, `capabilities`, `search("assignee = currentUser() AND resolution = Unresolved", 5)`; печатает таблицу «инстанс / пользователь / tempo / epicLinkField / задач». **Только GET**

**Готово, когда:** `npm run build && npm run lint && npm test` зелёные; `npm run smoke` показывает
для Pilot `tempo=true, epicLinkField=customfield_10100`, для sccloud и tatikoma `tempo=false,
customfield_10102`, для Cloud `epicLinkField=null`, у каждого больше 0 задач (или честно 0).

**Сессия:** sonnet, high; после этапа 1.

### 3. Дерево задач и фильтры
Разделы «Задачи» и «Фильтры» как в прототипе: три режима, поиск, быстрые фильтры, JQL,
сохранённые и избранные фильтры, догрузка списка.

- [ ] `src/jql.ts` + `test/jql.test.ts`: `buildJql({mode, projectKey, jql, quick:{statusCategory[], types[], priorities[]}, text})` — «на мне» = `assignee = currentUser() AND resolution = Unresolved`; текст → `text ~ "…"`, ключ вида `ABC-123` → `key = ABC-123`; `ORDER BY updated DESC`; экранирование кавычек
- [ ] `src/state/filters.ts`: режим, проект, быстрые фильтры, инстансы (фильтр по инстансу на клиенте — какие инстансы опрашивать), локальные фильтры в `globalState`
- [ ] `issuesTree.ts`: узлы инстансов (имя, хост в description, бейдж-счётчик; при ошибке — узел ошибки с действием «Проверить подключение»), задачи (иконка по категории статуса через `ThemeIcon` + цвет, label `KEY summary`, description статус, tooltip markdown), узел «Загрузить ещё»
- [ ] Команды `setMode`, `pickProject` (QuickPick проектов по всем инстансам), `quickFilters` (QuickPick с `canPickMany`, группы через separators: категория статуса, тип, приоритет, инстанс), `editJql` (InputBox с текущим JQL), `search` (InputBox: текст или ключ), сброс фильтров
- [ ] Бейдж активных фильтров в заголовке view (`TreeView.description`, например «2 фильтра · GARM»)
- [ ] `filtersTree.ts`: группы «Мои» (локальные) и «Избранные в Jira» (по инстансам); клик → режим JQL с этим запросом; `saveFilter`, `deleteFilter`
- [ ] `openIssueByKey`: ключ → инстанс по префиксу проекта (кэш проектов инстанса), иначе QuickPick инстанса
- [ ] Клик по задаче вызывает `jiraffe.openIssue` (пока заглушка: `showInformationMessage`)

**Готово, когда:** тесты `jql.test.ts` зелёные, `npm run build && npm run lint && npm test`
проходят. Smoke дополнительно выполняет `buildJql` для режимов «на мне» и «проект GARM» и печатает
счётчики. Пользователь по F5 видит свои задачи в трёх инстансах, переключает режимы и фильтры.

**Сессия:** sonnet, high; после этапа 2.

### 4. Карточка задачи
Webview-вкладка карточки: шапка, вкладки «Описание», «Комментарии», «История», «Журнал работ»
(только чтение), правая колонка мета-данных. Вложения и картинки — этап 5.

- [ ] `client.issue(key, 'renderedFields,changelog')`, `watchers(key)`, `worklogs(key)` и маппинг в `IssueDetail`/`Worklog` (Epic через `caps.epicLinkField` или `parent`)
- [ ] `src/panels/html.ts`: каркас с CSP (`default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-…'`), подключение `dist/webview/issue.js` и `webview/common.css`
- [ ] `src/panels/protocol.ts`: `host→view: {type:'issue', data}`, `{type:'loading'}`, `{type:'error', message}`; `view→host: openIssue, openEpic, openRelease, openInBrowser, copyKey, logWork, pin, switchTab`
- [ ] `IssuePanelManager`: одна preview-панель, которая переиспользуется; `pin` переводит текущую в закреплённые (заголовок без изменений, новая preview создаётся при следующем открытии); повторное открытие уже закреплённой задачи фокусирует её; `retainContextWhenHidden: false`, состояние вкладки через `setState`
- [ ] `webview/issue.ts` + `common.css`: разметка из `prototype/index.html` (функция `vIssue` и стили `.iv`, `.meta`, `.subtabs`, `.cm`, `.hi`, `table.t`), цвета через `--vscode-*` (editor.background, foreground, descriptionForeground, textLink.foreground, button.*, badge.*, panel.border, list.hoverBackground)
- [ ] Описание санитизируется в хосте (`sanitize-html`, белый список тегов из рендера Jira: p, br, h1–h6, ul, ol, li, pre, code, a, strong, em, table, img, span, div, blockquote). Ссылки открываются через `openExternal`. `img` пока заменяются плейсхолдером «картинка — этап 5»
- [ ] Кнопки шапки: «Ключ» (копировать), «Открыть в Jira», «Залогать время» (пока заглушка), «Закрепить»; ссылки эпика и релиза отправляют сообщения в хост (обработчики — этап 7, пока заглушки)
- [ ] `test/mappers.issue.test.ts`: фикстура JSON задачи DC (собрать из живого ответа через smoke, выкинув лишнее и персональные данные) → `IssueDetail`, включая changelog «было → стало»

**Готово, когда:** тесты зелёные, `npm run build && npm run lint && npm test` проходят.
Пользователь открывает GARM-задачу из дерева: видны описание, комментарии, история и журнал;
вторая задача открывается в той же вкладке, после «Закрепить» — в новой; карточка читается в
светлой и тёмной теме.

**Сессия:** sonnet, high (эталон разметки — прототип); после этапа 3.

### 5. Вложения и картинки
Вкладка «Вложения» и картинки в описании: скачивание с авторизацией, превью, сохранение на диск,
открытие текстовых файлов в редакторе.

- [ ] `client.downloadAttachment(url, maxBytes)` → `Uint8Array` + mime (тот же auth-заголовок; ответ больше лимита обрывается с ошибкой)
- [ ] Превью: для картинок `thumbnailUrl` (если есть), иначе контент до `jiraffe.maxImageMb`; в webview передаются `data:` URI порциями (сообщение `attachmentPreview {id, dataUri}`), а не всё сразу
- [ ] Картинки в описании: в `descriptionHtml` хост находит `img src`, относящиеся к инстансу (`/secure/attachment/…`, `/secure/thumbnail/…`, абсолютные на тот же хост), скачивает и подменяет на `data:`; чужие хосты → ссылка вместо картинки (CSP их не пустит)
- [ ] Вкладка «Вложения»: сетка как в прототипе (`.att-grid`), лайтбокс, кнопки «Скачать», «Скачать все», «Открыть в редакторе» (текстовые mime и `.log/.json/.txt/.xml/.csv` → `openTextDocument` из сохранённого файла)
- [ ] Сохранение в `<workspace>/.jiraffe/<KEY>/<filename>` (нет workspace → `os.tmpdir()/jiraffe/<KEY>`); защита имени файла от `..` и `/`; повторное скачивание перезаписывает
- [ ] `test/attachments.test.ts`: подмена `img src` (свои/чужие хосты, context path), санитизация имени файла, лимит размера

**Готово, когда:** тесты зелёные, сборка и линт проходят. Smoke скачивает одно вложение
(первое найденное у задачи с вложениями из `assignee = currentUser()`) в tmp и печатает размер —
это только GET. Пользователь видит скриншоты из задачи прямо в карточке.

**Сессия:** opus, high — авторизованные загрузки, CSP и санитизация, тут нужно суждение; после
этапа 4.

### 6. Журнал работ и Tempo
Запись времени из карточки и боковой панели, рабочие атрибуты Tempo с инстанса, сводка
«сегодня» в разделе Tempo и в строке состояния.

- [ ] Проверить допущения о Tempo v3 по живому Pilot **только GET-запросами**: `/rest/tempo-core/1/work-attribute` (формат атрибутов) и чтение ворклогов (`/rest/tempo-timesheets/3/worklogs?dateFrom&dateTo&username`). Результат и реальные форматы записать в раздел «Допущения» этого файла
- [ ] `src/jira/tempo.ts`: `attributes()`, `worklogs({dateFrom, dateTo, username, issueKey?})` (если endpoint подтвердился), `addWorklog({issueKey, author, started, timeSpentSec, comment, attributes, remainingEstimateSec})` — payload как в `pilot-jira/jira.sh` `cmd_worklog`
- [ ] Стандартный путь: `client.addWorklog(key, {started, timeSpentSec, comment}, adjustEstimate)`; AI Tokens без Tempo → `(AI Tokens: N)` в конце комментария
- [ ] Форма «Залогать время» — webview-диалог в карточке (как `logHtml` в прототипе) и команда `jiraffe.logWork` (QuickInput: длительность → дата → комментарий → атрибуты) для вызова из дерева и палитры. Поля атрибутов строятся по ответу `work-attribute`
- [ ] `remainingEstimateSec` для Tempo = `max(remaining − spent, 0)` по `timetracking` задачи (допущение о поведении — см. «Риски»)
- [ ] После записи: обновить карточку (журнал, «Залогано»), дерево Tempo и строку состояния; сообщение `Залогано 1ч 30м в GARM-710 · Tempo`
- [ ] Сводка «сегодня»: Tempo-инстанс — `tempo.worklogs(today, me)`; без Tempo — JQL `worklogAuthor = currentUser() AND worklogDate = "YYYY-MM-DD"`, затем `worklogs(key)` и фильтр по автору и дате. Сумма по всем инстансам
- [ ] `tempoView.ts` (WebviewView): блок «Сегодня» из прототипа (`renderTempo`), без недельной таблицы; кнопка «Залогать»; `statusBar.ts`: `$(clock) Сегодня 3ч 15м / 8ч`, клик фокусирует раздел Tempo
- [ ] Вкладка «Журнал работ» карточки: на Tempo-инстансе колонки атрибутов (если чтение Tempo подтвердилось), иначе без них
- [ ] `test/worklog.test.ts`: payload Tempo (атрибуты, `remainingEstimateSeconds`, `dateStarted` без зоны), payload стандартный (`started` с локальным смещением, AI Tokens в комментарии), сумма «сегодня»

**Готово, когда:** тесты зелёные, сборка и линт проходят. В smoke добавлены атрибуты Pilot и
сумма «сегодня» по каждому инстансу — только GET. **Запись проверяет пользователь:** одна запись
в Pilot (Tempo с AI Tokens) и одна в sccloud, обе видны в Jira и в карточке.

**Сессия:** opus, high — непроверенные endpoint'ы и запись в рабочие Jira; после этапа 5.

### 7. Эпики и релизы
Разделы «Эпики» и «Релизы», вкладки эпика и релиза с прогрессом и таблицей задач.

- [ ] Эпики проекта: DC — `project = X AND issuetype = Epic AND resolution = Unresolved ORDER BY created DESC` (при неудаче — по id типа эпика); Cloud — то же, с `hierarchyLevel = 1` из `issueTypes`
- [ ] Задачи эпика: DC — `cf[<id>] = KEY` (из `caps.epicLinkField`), Cloud — `parent = KEY`; прогресс по `statusCategory`
- [ ] Релизы: `/rest/api/2/project/{key}/versions` (выпущенные / невыпущенные, даты), задачи — `fixVersion = <id>`, счётчики — `/rest/api/2/version/{id}/relatedIssueCounts`
- [ ] `epicsTree.ts` / `releasesTree.ts`: выбор проекта (общий с «Задачами» или свой — свой, как в прототипе), строки с `done/total` в description
- [ ] `listPanel.ts` + `webview/list.ts`: вкладки эпика и релиза по `vEpic` / `vRel` из прототипа (сводка, сегментная полоса, легенда, таблица); строка таблицы открывает карточку
- [ ] Подключить заглушки этапа 4: ссылки эпика и релиза в карточке открывают эти вкладки
- [ ] `test/epics.test.ts`: построение JQL для DC и Cloud, подсчёт прогресса

**Готово, когда:** тесты зелёные, сборка и линт проходят. Smoke печатает число эпиков и версий
GARM и NEWMFC и прогресс первого эпика. Пользователь открывает эпик GARM и релиз Pulse.

**Сессия:** sonnet, high; после этапа 6 (общие файлы панелей).

### 8. Полировка и упаковка
Пустые состояния, ошибки, настройки, документация, `.vsix` для установки.

- [ ] Пустые состояния views через `viewsWelcome` (нет инстансов → кнопка «Добавить Jira»)
- [ ] Ошибки сети и 401 на узле инстанса не ломают остальные инстансы; повторный запрос по `refresh`
- [ ] Кэш в памяти: проекты, типы, приоритеты, возможности — на сессию; задачи — до `refresh`
- [ ] README: установка из `.vsix`, добавление инстанса (где взять PAT и API token), чекбоксы функций MVP отмечены по факту
- [ ] `CHANGELOG.md` 0.1.0, версия 0.1.0 в `package.json`, иконка расширения
- [ ] `npm run package` → `jiraffe-0.1.0.vsix`

**Готово, когда:** `npm run build && npm run lint && npm test && npm run smoke && npm run package`
проходят. Пользователь ставит `.vsix` в чистый профиль VS Code (`code --profile jiraffe-test
--install-extension jiraffe-0.1.0.vsix`) и проходит чеклист приёмки из отчёта.

**Сессия:** sonnet, high; последним.

## Промты сессий

Общие строки (входят в каждый промт ниже):

> Работаем в `/Users/fost/Projects/jiraffe`. Читай: `roadmap-mvp.md` (разделы «Контекст и
> ограничения», «Архитектура и контракты» и свой этап), `README.md`. Эталон UI —
> `prototype/index.html`: открывать нужную функцию через grep, файл целиком не читать.
> Длинный вывод команд — в лог (`cmd > /tmp/jiraffe-x.log 2>&1; tail -30`). Галочки в
> roadmap — по факту проверки. Запросы к живым Jira — только GET, токены из env
> (`JIRA_*_TOKEN`, `JIRA_*_URL`, `JIRA_CLOUD_EMAIL`), в файлы и вывод токены не печатать.
> Не коммитить и не пушить — это сделает приёмка. Чужие файлы вне скоупа этапа не трогать,
> «заодно улучшить» — нет. Вопрос, на который нет ответа в roadmap, — в отчёт, не додумывать.
> Последним сообщением — отчёт: сделано (файлы) / отклонения от плана / не проверено /
> открытые вопросы. Отчёт — единственное, что увидит приёмка.

### Сессия 1

```
Сессия 1 — Jiraffe: каркас расширения · Модель: sonnet, effort: high · первая

Работаем в /Users/fost/Projects/jiraffe. Задача: собрать пустое, но рабочее расширение VS Code — этап 1 roadmap-mvp.md. Репо пустое (README, prototype/, roadmap).
Читай: roadmap-mvp.md (контекст, архитектура, этап 1), README.md. Иконка — svg IC.giraffe в prototype/index.html (grep "giraffe:").

Уже решено, не переспрашивать: TypeScript strict, esbuild с двумя бандлами (host cjs/node → dist/extension.js; webview iife/browser → dist/webview/), vitest, eslint flat config с typescript-eslint, engines.vscode ^1.90.0, @types/vscode@1.90, Node 20 API (встроенный fetch). Views и их id — как в этапе 1. Webview-бандл пока может собирать пустой webview/issue.ts.

Порядок: чекбоксы этапа 1 сверху вниз.

DoD: npm run build && npm run lint && npm test && npm run package — все зелёные, jiraffe-0.0.1.vsix собран. Тесты duration покрывают все форматы из чекбокса.

Не делать: никакой логики Jira, никаких зависимостей, кроме перечисленных devDeps. Остальное — в общих строках roadmap (раздел «Промты сессий»), они обязательны.
Последним сообщением — отчёт: сделано / отклонения / не проверено / вопросы.
```

### Сессия 2

```
Сессия 2 — Jiraffe: инстансы и клиент API · Модель: sonnet, effort: high · после сессии 1

Работаем в /Users/fost/Projects/jiraffe. Задача: этап 2 roadmap-mvp.md — хранение инстансов, авторизация DC/Cloud, HttpClient, JiraClient, определение возможностей, команды добавления инстанса, smoke.
Читай: roadmap-mvp.md (таблица фактов об инстансах, решения, архитектура, этап 2). Рабочие примеры вызовов: ~/.claude/skills/pilot-jira/jira.sh (функция api, Bearer), ~/.claude/skills/troy-jira/jira.sh (Basic, /search/jql, nextPageToken), ~/.claude/skills/tatikoma-jira/jira.sh (context path /jira) — открывать grep'ом нужные функции.
Точки входа: src/extension.ts (activate из сессии 1), package.json contributes.commands.

По реальному коду (после приёмки этапа 1): в src/extension.ts заглушки EmptyTree (4 дерева) и TempoViewProvider объявлены прямо в файле — не трогать, их заменят этапы 3 и 6; activationEvents пустой (views/команды активируют сами), новые команды — только в contributes.commands. scripts/smoke.ts — заглушка, заменить целиком; запускается через tsx вне VS Code, поэтому src/jira/* и src/state/* (кроме кода, которому нужен vscode API — InstanceStore) не импортируют 'vscode', иначе smoke и vitest упадут. Dev-Node 22 (vsce 4 его требует), но рантайм VS Code 1.90 — Node 20: API выше Node 20 не использовать, @types/node@20 это и ловит в `npm run lint` (там же tsc --noEmit). Один tsconfig на всё (lib ES2022+DOM).

Уже решено: типы — дословно из раздела «Архитектура»; токен в SecretStorage под `jiraffe.token.<id>`; Tempo определяется по GET /rest/tempo-core/1/work-attribute (200 → есть); Epic Link — по /rest/api/2/field, schema.custom == "com.pyxis.greenhopper.jira:gh-epic-link"; сообщения об ошибках — по-русски.

Порядок: чекбоксы этапа 2 сверху вниз; smoke — последним.

DoD: npm run build && npm run lint && npm test зелёные; npm run smoke печатает таблицу по 4 инстансам с ожидаемыми tempo/epicLinkField из «Готово, когда» этапа 2. Если факт расходится с таблицей roadmap — не подгонять, а записать в отчёт.

Не делать: деревья и webview (этапы 3–4), любые запросы кроме GET к живым Jira. Остальное — общие строки roadmap.
Последним сообщением — отчёт.
```

### Сессия 3

```
Сессия 3 — Jiraffe: дерево задач и фильтры · Модель: sonnet, effort: high · после сессии 2

Работаем в /Users/fost/Projects/jiraffe. Задача: этап 3 roadmap-mvp.md — разделы «Задачи» и «Фильтры», buildJql, быстрые фильтры, JQL, сохранённые и избранные фильтры, догрузка.
Читай: roadmap-mvp.md (решения, архитектура, этап 3). Эталон поведения — prototype/index.html, функции renderTree, renderExtra, renderChips, renderFilters, qpHtml (grep по имени). UI переносится на нативные TreeView/QuickPick/InputBox, не на webview.
Точки входа: src/jira/client.ts (search, projects, issueTypes, priorities, favouriteFilters — из сессии 2), src/state/instances.ts, src/extension.ts.

Уже решено: фильтр статуса — по statusCategory (new/indeterminate/done → «Открыта/В работе/Готово»); фильтры превращаются в JQL на сервере; фильтр по инстансу — какие инстансы опрашивать; локальные фильтры в globalState; клик по задаче → команда jiraffe.openIssue (пока заглушка).

Порядок: jql.ts с тестами → filters.ts → issuesTree → команды → filtersTree → openIssueByKey.

DoD: npm run build && npm run lint && npm test зелёные; smoke дополнен счётчиками по buildJql для «на мне» и «проект GARM».

Не делать: карточку задачи. Остальное — общие строки roadmap.
Последним сообщением — отчёт + короткий чеклист для проверки по F5.
```

### Сессия 4

```
Сессия 4 — Jiraffe: карточка задачи · Модель: sonnet, effort: high · после сессии 3

Работаем в /Users/fost/Projects/jiraffe. Задача: этап 4 roadmap-mvp.md — webview-карточка задачи (шапка, описание, комментарии, история, журнал работ — чтение, мета-колонка), preview-вкладка с закреплением.
Читай: roadmap-mvp.md (решения, архитектура, этап 4). Эталон разметки и CSS — prototype/index.html: функция vIssue и стили .iv, .meta, .mg, .mr, .subtabs, .cm, .hi, .chg, table.t, .pill, .btn (grep). Цвета прототипа заменить на --vscode-* переменные.
Точки входа: src/jira/client.ts, src/jira/mappers.ts, команда jiraffe.openIssue (заглушка из сессии 3), esbuild.mjs (webview-бандл).

Уже решено: CSP и протокол сообщений — дословно из этапа 4; санитизация в хосте через sanitize-html (это единственная новая runtime-зависимость); картинки описания — пока плейсхолдер; одна preview-панель плюс закреплённые; кнопка «Залогать время» и ссылки эпика/релиза — заглушки с сообщением «будет в этапе 6/7».

Порядок: client.issue/watchers/worklogs + маппинг + тест на фикстуре → html.ts/protocol.ts → IssuePanelManager → webview/issue.ts + common.css.

DoD: npm run build && npm run lint && npm test зелёные; фикстура в test/fixtures без персональных данных (имена и e-mail заменить).

Не делать: вложения и картинки (этап 5), запись worklog (этап 6). Остальное — общие строки roadmap.
Последним сообщением — отчёт + чеклист для проверки по F5 (светлая и тёмная тема).
```

### Сессия 5

```
Сессия 5 — Jiraffe: вложения и картинки · Модель: opus, effort: high · после сессии 4

Работаем в /Users/fost/Projects/jiraffe. Задача: этап 5 roadmap-mvp.md — вкладка «Вложения», картинки в описании через авторизованное скачивание, сохранение и открытие файлов.
Читай: roadmap-mvp.md (решения про вложения, CSP, санитизацию; этап 5). Эталон — prototype/index.html: блок sub=='att' в vIssue, стили .att-grid/.att, лайтбокс (A.img).
Точки входа: src/jira/http.ts (auth), src/panels/issuePanel.ts, src/panels/protocol.ts, webview/issue.ts, место плейсхолдера картинок в санитизации (сессия 4).

Уже решено: превью приходят в webview как data: URI порциями; лимит jiraffe.maxImageMb; чужие хосты — ссылкой; путь сохранения — .jiraffe/<KEY>/ или tmpdir; текстовые файлы открываются в редакторе из сохранённой копии.

Порядок: чекбоксы этапа 5 сверху вниз; тесты — вместе с каждым модулем.

DoD: npm run build && npm run lint && npm test зелёные; smoke скачивает одно вложение в tmp (только GET). В отчёте — как CSP и санитизация защищают от HTML из Jira.

Не делать: изменение CSP в сторону ослабления (никаких 'unsafe-inline' для скриптов, никаких внешних img-src). Остальное — общие строки roadmap.
Последним сообщением — отчёт.
```

### Сессия 6

```
Сессия 6 — Jiraffe: журнал работ и Tempo · Модель: opus, effort: high · после сессии 5

Работаем в /Users/fost/Projects/jiraffe. Задача: этап 6 roadmap-mvp.md — запись времени (Tempo v3 на Pilot, стандартный worklog на остальных), атрибуты с инстанса, сводка «сегодня» в разделе Tempo и строке состояния.
Читай: roadmap-mvp.md (таблица фактов, допущения про Tempo, этап 6, риски). Рабочий payload: ~/.claude/skills/pilot-jira/jira.sh функция cmd_worklog и ~/.claude/skills/sccloud-jira/jira.sh cmd_worklog. Эталон UI — prototype/index.html: logHtml, renderTempo, parseDur.
Точки входа: src/jira/client.ts, src/jira/capabilities.ts, src/duration.ts, src/panels/issuePanel.ts (заглушка «Залогать время»), views jiraffe.tempo (заглушка из сессии 1).

Уже решено: атрибуты из /rest/tempo-core/1/work-attribute, AI Tokens без Tempo — в комментарий «(AI Tokens: N)»; сводка в MVP — только «сегодня»; недельной таблицы нет.

Порядок: сначала проверка допущений GET-запросами и запись результатов в раздел «Допущения» roadmap → tempo.ts и стандартный addWorklog с тестами payload → форма и команда → сводка «сегодня» → tempoView и statusBar.

DoD: npm run build && npm run lint && npm test зелёные; smoke печатает атрибуты Pilot и «сегодня» по инстансам. POST в живые Jira НЕ выполнять ни разу — запись проверит пользователь по чеклисту из отчёта.

Не делать: недельную сводку, правку и удаление ворклогов. Остальное — общие строки roadmap.
Последним сообщением — отчёт + чеклист проверки записи (Pilot с AI Tokens, sccloud).
```

### Сессия 7

```
Сессия 7 — Jiraffe: эпики и релизы · Модель: sonnet, effort: high · после сессии 6

Работаем в /Users/fost/Projects/jiraffe. Задача: этап 7 roadmap-mvp.md — разделы «Эпики» и «Релизы», вкладки эпика и релиза.
Читай: roadmap-mvp.md (решения про Epic Link/parent, этап 7). Эталон — prototype/index.html: renderEpics, renderRels, vEpic, vRel, progressBlock, issueTable, segBar.
Точки входа: src/jira/client.ts, src/jira/capabilities.ts (epicLinkField), src/panels/html.ts и protocol.ts, заглушки ссылок эпика/релиза в карточке (сессия 4).

Уже решено: DC — cf[<id>] = KEY, Cloud — parent = KEY; прогресс по statusCategory; у разделов свой выбор проекта.

Порядок: чекбоксы этапа 7 сверху вниз.

DoD: npm run build && npm run lint && npm test зелёные; smoke печатает эпики и версии GARM и NEWMFC.

Не делать: правку эпиков и версий. Остальное — общие строки roadmap.
Последним сообщением — отчёт + чеклист для проверки по F5.
```

### Сессия 8

```
Сессия 8 — Jiraffe: полировка и упаковка · Модель: sonnet, effort: high · после сессии 7

Работаем в /Users/fost/Projects/jiraffe. Задача: этап 8 roadmap-mvp.md — пустые состояния, устойчивость к ошибкам инстанса, кэш, README, CHANGELOG, .vsix 0.1.0.
Читай: roadmap-mvp.md (этап 8), README.md.
Точки входа: package.json (contributes.viewsWelcome, version), src/views/*.ts, src/jira/client.ts.

Уже решено: кэш только в памяти; README отмечает чекбоксы функций по факту, не авансом.

Порядок: чекбоксы этапа 8 сверху вниз.

DoD: npm run build && npm run lint && npm test && npm run smoke && npm run package зелёные; jiraffe-0.1.0.vsix собран.

Не делать: функции из «Позже» README. Остальное — общие строки roadmap.
Последним сообщением — отчёт + полный чеклист приёмки MVP для пользователя.
```

## Риски и открытые вопросы

- **Tempo v3 — чтение ворклогов.** Endpoint и параметры не проверены. Узнаем в начале этапа 6
  по GET-запросу. Если не работает, атрибуты в журнале не показываем, а сводку строим через JQL
  `worklogDate`.
- **`remainingEstimateSeconds` в Tempo.** Скрипт pilot-jira всегда шлёт `0`, то есть обнуляет
  остаток. В плане — `max(remaining − spent, 0)`. **Вопрос пользователю:** нужно ли вообще
  трогать остаток? Для стандартного worklog по умолчанию стоит `adjustEstimate=leave`, как в
  скриптах.
- **JQL `issuetype = Epic` на русских инстансах** может не сработать — запасной путь по id типа
  заложен в этап 7.
- **Картинки в описании.** У Jira DC в `renderedFields` бывают ссылки на `/secure/thumbnail` и
  на внешние ресурсы. Чужие показываем ссылкой: CSP ослаблять не будем.
- **Разные версии Jira** (8.22 и 9.12). Возможны расхождения в `/search` и changelog. Smoke
  гоняет все инстансы на каждом этапе, так что поймаем рано.
- **Ворклоги Tempo в стандартном `/worklog`.** Если на Pilot их там нет, журнал задачи на Pilot
  читаем через Tempo (этап 6).
- **Секреты.** Токены не попадают ни в логи, ни в фикстуры, ни в smoke-вывод. Это проверяется
  на приёмке каждого этапа.

## После MVP

- Недельный timesheet Tempo по всем инстансам (`vTS` в прототипе).
- Ответ в комментарии, смена статуса, назначение исполнителя, ветка git от задачи — из
  «Позже» README.

## Порядок работы

Все этапы в одном репо, поэтому идут строго последовательно: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.
Каждый следующий стартует после приёмки предыдущего (`/plan-review`: проверка, коммит).
Начинаем с сессии 1. Этап 7 технически не зависит от 6, но они делят файлы панелей и протокола,
поэтому тоже последовательно. После этапов 3, 4, 6 и 8 пользователь проверяет по F5 или `.vsix`
по чеклисту из отчёта.
