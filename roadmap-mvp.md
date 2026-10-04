# Jiraffe MVP — расширение VS Code для Jira

> Статус: этап 7 принят 2026-10-04 (этапы 1–7 приняты) · следующий — этап 8 (сессия 8) · ждёт пользователя: F5-проверка этапов 1–7, живая запись времени (Pilot/Tempo и sccloud) и решения на подтверждение (`roadmap-mvp.pending.md`)
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
    (и/или `&projectKey=` / `&issue=`). **Проверено 2026-10-04 (этап 6, GET на Pilot):** endpoint
    отвечает 200, массив. `username` фильтрует по автору (без него — ворклоги текущего пользователя;
    `worker=<key>` даёт то же; несуществующий логин — 404 `{"errors":{"user":…}}`); `projectKey`
    фильтрует по проекту (все авторы); **фильтра по задаче нет** — `issue`, `issueKey`, `issueId`,
    `taskKey` сервер молча игнорирует; без `dateFrom/dateTo` — пустой массив. Элемент:
    `{id, jiraWorklogId, timeSpentSeconds, dateStarted, dateCreated, dateUpdated, comment, self,
    author:{name, key, displayName, avatar, self}, issue:{id, key, projectId, summary,
    remainingEstimateSeconds, issueType:{name, iconUrl}, self}, worklogAttributes:[{key, value}]}`;
    `id` = `jiraWorklogId` = id ворклога Jira (во всех 36 проверенных); `dateStarted` —
    `YYYY-MM-DDTHH:mm:ss.SSS` **без пояса**; значение числового атрибута — строка с дробью
    (`"120000.0"`); у части ворклогов `worklogAttributes` пустой. Один ворклог —
    `GET …/3/worklogs/{id}` (те же поля + `workAttributeValues`). Поэтому атрибуты в журнале
    карточки берутся по id стандартных ворклогов (до 50, параллельно 4), а «сегодня» на Tempo —
    одним GET за день. Сумма за день совпала со стандартным путём (JQL `worklogDate` + `/worklog`)
    на прошедшем дне с записями.
  - JQL `issuetype = Epic` находит эпики на русских инстансах. Если нет, ищем по id типа
    из `/rest/api/2/issuetype`.
  - Ворклоги Tempo Server видны в стандартном `/rest/api/2/issue/{key}/worklog`. **Подтверждено
    (этап 6):** все ворклоги Tempo задачи нашлись в `/worklog` по id — журнал карточки на Pilot
    остаётся стандартным, Tempo лишь добавляет атрибуты.
  - Формат описаний рабочих атрибутов (`type`: `INPUT_FIELD`, `STATIC_LIST`, …) уточнить по
    живому ответу на этапе 6. **Проверено (этап 6):** `GET /rest/tempo-core/1/work-attribute` → массив
    `{id, key, name, type:{name, value, systemType}, required, sequence}`; тип — в `type.value`
    (объект, не строка; `type.name` локализован: «Числовое поле ввода»). На Pilot один атрибут:
    `AI Tokens`, `_AITokensUsed_`, `INPUT_NUMERIC`, необязательный. `STATIC_LIST`
    (`staticListValues`), `INPUT_FIELD`, `CHECKBOX` живьём не встречались — разобраны по документации
    Tempo Server, покрыты только тестами; `ACCOUNT`/`DYNAMIC_DROPDOWN`/`BILLABLE_SECONDS` форма
    не рисует (обязательный такой атрибут — предупреждение в форме).

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

- [x] `src/jira/types.ts` — типы из раздела «Архитектура» дословно
- [x] `src/jira/http.ts`: DC → `Authorization: Bearer <token>`, Cloud → `Basic base64(email:token)`; `baseUrl` может содержать context path (`https://host/jira`); `JiraError { status, message, url }`; сообщения для 401/403/404/сети на русском
- [x] `src/jira/client.ts`: `myself`, `search(jql, fields, page)` (DC — `GET /rest/api/2/search?startAt=`, Cloud — `GET /rest/api/2/search/jql?nextPageToken=`), `issue(key, expand)`, `fields`, `projects`, `issueTypes`, `priorities`, `favouriteFilters` (`/rest/api/2/filter/favourite`)
- [x] `src/jira/mappers.ts`: raw → `IssueSummary`/`UserRef` (DC: `name`; Cloud: `accountId`)
- [x] `src/jira/capabilities.ts`: Tempo по `/rest/tempo-core/1/work-attribute` (200/404), Epic Link по `/rest/api/2/field`, `serverInfo` → версия
- [x] `src/state/instances.ts`: CRUD в `globalState` под `jiraffe.instances`, токены в `SecretStorage`; `id` = slug хоста
- [ ] Команда `jiraffe.addInstance` — многошаговый QuickInput (URL → тип DC/Cloud → email для Cloud → токен → проверка `/myself` → имя), плюс `removeInstance`, `testConnection`, `refreshCapabilities` — *код и сборка есть, QuickInput-цепочку и remove/test/refresh в VS Code проверяет пользователь (F5)*
- [x] `test/http.test.ts`, `test/client.test.ts` с моком `fetch`: заголовки обоих типов, context path, пагинация DC и Cloud, маппинг 401
- [x] `scripts/smoke.ts`: для каждого инстанса с заданным в env токеном — `myself`, `capabilities`, `search("assignee = currentUser() AND resolution = Unresolved", 5)`; печатает таблицу «инстанс / пользователь / tempo / epicLinkField / задач». **Только GET**

**Готово, когда:** `npm run build && npm run lint && npm test` зелёные; `npm run smoke` показывает
для Pilot `tempo=true, epicLinkField=customfield_10100`, для sccloud и tatikoma `tempo=false,
customfield_10102`, для Cloud `epicLinkField=null`, у каждого больше 0 задач (или честно 0).

**Сессия:** sonnet, high; после этапа 1.

**Решения (2026-10-04, по итогам сессии 2):**
- Раскладка — как в «Архитектуре»: `src/jira/{types,http,client,mappers,capabilities}.ts`, `src/state/instances.ts`, `test/{http,client}.test.ts`, `scripts/smoke.ts`. Вне списка: `src/commands/instances.ts` (четыре команды инстансов — чтобы не раздувать `extension.ts`; в `extension.ts` только создание `InstanceStore` и `registerInstanceCommands`). В `package.json` добавлены 4 команды (`addInstance`, `removeInstance`, `testConnection`, `refreshCapabilities`). Заглушки деревьев/Tempo не тронуты.
- Контракт: `HttpClient.getJson<T>(path, query?)` (только GET), `JiraError{status, message, url, code}`; `code`: `http` | `network` (status 0) | `format` (200, но не JSON). Токен ни в message, ни в url не попадает (тест). Таймаут 30 с (`AbortSignal.timeout`). `createJiraClient(instance, token, {fetchImpl?})` в `client.ts` — единая фабрика для команд и smoke. `JiraClient`: `myself`, `search(jql, fields?, {startAt|nextPageToken, maxResults})`, `issue(key, expand: string | string[])` (возвращает сырой JSON, маппинг в `IssueDetail` — этап 4), `fields`, `projects`, `issueTypes`, `priorities`, `favouriteFilters`, `serverVersion`. `SearchPage`: DC — `next.startAt` пока `startAt+len < total`; Cloud — `next.nextPageToken`, пока `!isLast`; у Cloud `total` нет (поэтому в smoke «5+»). `fields` по умолчанию — `SUMMARY_FIELDS`. `InstanceStore` не импортирует vscode (только `import type`), поэтому тестируется в vitest; есть `onDidChange(fn)` — для деревьев этапа 3. `id` инстанса — slug `host+path` (`atlassian-tatikoma-ru-jira`); повторное добавление того же URL — модальное «Заменить?».
- Отступление от формулировки плана: **Tempo на sccloud/tatikoma не даёт 404** — `/rest/tempo-core/1/work-attribute` отвечает 302 на `login.jsp`, `fetch` идёт по редиректу и получает 200 с HTML. Поэтому «Tempo нет» = 404 **или** `JiraError.code === 'format'` (HTML вместо JSON). 401/403/сеть пробрасываются (молча «нет Tempo» не говорим). Тест на этот случай есть.
- На Cloud `detectCapabilities` не ходит ни за Tempo, ни за `/field`: `tempo=false`, `epicLinkField=null` (Tempo Cloud — другой API, вне MVP; эпик там — `parent`).
- `Instance.epicLinkField` (ручной override из настроек) пока никем не заполняется — UI настроек инстанса в плане нет; потребители (этапы 4, 7) должны брать `instance.epicLinkField ?? instance.caps?.epicLinkField`.
- В QuickInput `addInstance` 5 шагов (URL → тип DC/Cloud (по хосту `*.atlassian.net` предвыбран Cloud) → email (Cloud) → токен (password) → проверка `/myself` и имя по умолчанию = хост). Шага «назад» нет — Esc отменяет всё; `title` у QuickPick в `@types/vscode@1.90` нет — номер шага в `placeHolder`. Если определение возможностей упало после успешного `/myself`, инстанс всё равно сохраняется, без `caps` (предупреждение + команда «Обновить возможности»).
- Smoke: `npm run smoke` — таблица по 4 инстансам, расхождение с ожиданием из roadmap → строка «РАСХОЖДЕНИЕ» и exit 1; инстанс без токена пропускается. URL — из `JIRA_*_URL` или дефолт. Прогон 2026-10-04: pilot `tempo=true, customfield_10100`; sccloud и tatikoma `tempo=false, customfield_10102`; Cloud `tempo=false, null`; у всех задач > 0 (Cloud — «5+», т.к. без total). Все расхождений с таблицей фактов нет.
- **Не проверено (пользователь):** F5 — команды в палитре и вся QuickInput-цепочка, сохранение в `globalState`/`SecretStorage` в реальном VS Code, `removeInstance`/`testConnection`/`refreshCapabilities`. `favouriteFilters`, `projects`, `issueTypes`, `priorities` покрыты только моком, на живых Jira не вызывались. Атрибуты/ворклоги Tempo — этап 6.
- Стыковка с поздними этапами: `client.issue(key, 'renderedFields,changelog')` из этапа 4 работает как написано (строка принимается).
- *Приёмка:* `HttpClient` усилен. Токен `trim()`-ится, а пробел, перевод строки или не-ASCII внутри дают понятную ошибку до запроса: undici печатает невалидный заголовок вместе с токеном. Строки токена и auth-заголовка вычищаются (`***`) из всех сообщений. Сетевая ошибка показывает `cause.code` (`ENOTFOUND`, `ECONNRESET`), на TLS-ошибках подсказывает `NODE_EXTRA_CA_CERTS`. Обрыв или таймаут при чтении тела — тоже `JiraError network`. У 401 и 403 в сообщении есть `errorMessages` и `X-Authentication-Denied-Reason` (CAPTCHA на DC).
- *Приёмка, редиректы:* `fetch` следует редиректам (`follow`); undici снимает `Authorization` при смене origin (проверено экспериментом на Node 18/20/24). Режим `manual` отвергнут: undici отдаёт 302 как обычный ответ, и сломался бы признак «Tempo нет» через `login.jsp`. Вместо него после ответа проверяем: если `res.redirected` и origin сменился, бросаем `JiraError code:'redirect'` с текстом «Сервер перенаправил на <origin> — укажите этот адрес». Редирект в пределах того же origin (`login.jsp`) работает как раньше и даёт `format`; smoke по 4 инстансам после правки зелёный. **Любой новый метод HttpClient (бинарный GET для этапа 5, POST для этапа 6) обязан повторить ту же проверку origin и `scrub`** — заводить его рядом с `getJson`, а не голым `fetch`.
- *Приёмка, адрес инстанса:* `canonicalBaseUrl` (`http.ts`) убирает query, hash и `user:pw@`, а путь режет на `/browse/`, `/secure/`, `/projects/`, `/issues/`, `/plugins/`, `/rest/`, `/servicedesk/`, `/login.jsp`. Для `*.atlassian.net` остаётся только origin. Поэтому вставленная ссылка на задачу превращается в адрес инстанса. Для `http://` `addInstance` показывает модальное предупреждение. Токен валидируется в InputBox. `/myself` и определение возможностей идут под `withProgress`.
- *Приёмка, мелочи:* в Cloud-поиске нет `next`, если курсор повторился или страница пустая (защита от зацикливания); `maxResults` зажат в 1..100. Списочные методы на не-массив возвращают `[]`. `InstanceStore.list()` отбрасывает битые записи `globalState`, а исключение слушателя `onDidChange` не ломает `add/remove`. `refreshCapabilities` на Cloud пишет «Epic Link: parent».
- **Контракт эпика (для этапов 4 и 7, решено на приёмке):** эпик задачи определяется по `instance.kind`, а не по наличию поля. DC берёт `instance.epicLinkField ?? instance.caps?.epicLinkField`: значение поля — ключ эпика, а в JQL задачи эпика — `cf[<число из id>] = KEY`; если поля нет (`null`), эпика у задачи нет. Cloud берёт `fields.parent`: эпик — это `parent`, у которого `fields.issuetype.hierarchyLevel === 1` (у подзадачи `parent` — обычная задача, это не эпик); в JQL задачи эпика — `parent = KEY`. Atlassian перевёл company-managed проекты Cloud с `customfield_10014` на `parent`, поэтому на Cloud `/field` за Epic Link не запрашиваем. Шаблон `epicLinkField ?? caps.epicLinkField` для Cloud **не применять**: он даст `null`, и эпики пропадут.
- **Приёмка (2026-10-04, Opus, два прохода):** принят с оговорками: F5 — у пользователя. Проверено: `npm run build && npm run lint && npm test && npm run package` зелёные, 87 тестов (69 у исполнителя, 18 добавила приёмка: токен с `\r`/пробелом, scrub, `cause`, cross-origin redirect, 401 details, `canonicalBaseUrl`, курсор Cloud, JQL со спецсимволами и кириллицей, `maxResults`, замена инстанса и падающий слушатель). `npm run smoke` после правок: pilot `true/customfield_10100` 159, sccloud `false/customfield_10102` 76, tatikoma `false/customfield_10102` 186, Cloud `false/null` «5+». **Не проверено:** QuickInput и команды инстансов в VS Code (F5); `favouriteFilters`/`projects`/`issueTypes`/`priorities` на живых Jira — в начале этапа 3.

### 3. Дерево задач и фильтры
Разделы «Задачи» и «Фильтры» как в прототипе: три режима, поиск, быстрые фильтры, JQL,
сохранённые и избранные фильтры, догрузка списка.

- [x] `src/jql.ts` + `test/jql.test.ts`: `buildJql({mode, projectKey, jql, quick:{statusCategory[], types[], priorities[]}, text})` — «на мне» = `assignee = currentUser() AND resolution = Unresolved`; текст → `text ~ "…"`, ключ вида `ABC-123` → `key = ABC-123`; `ORDER BY updated DESC`; экранирование кавычек
- [x] `src/state/filters.ts`: режим, проект, быстрые фильтры, инстансы (фильтр по инстансу на клиенте — какие инстансы опрашивать), локальные фильтры в `globalState`
- [ ] `issuesTree.ts`: узлы инстансов (имя, хост в description, бейдж-счётчик; при ошибке — узел ошибки с действием «Проверить подключение»), задачи (иконка по категории статуса через `ThemeIcon` + цвет, label `KEY summary`, description статус, tooltip markdown), узел «Загрузить ещё» — *код и сборка есть, JQL проверен на живых Jira через smoke; отрисовку дерева и догрузку в VS Code проверяет пользователь (F5)*
- [ ] Команды `setMode`, `pickProject` (QuickPick проектов по всем инстансам), `quickFilters` (QuickPick с `canPickMany`, группы через separators: категория статуса, тип, приоритет, инстанс), `editJql` (InputBox с текущим JQL), `search` (InputBox: текст или ключ), сброс фильтров — *код и сборка есть, QuickPick/InputBox-цепочки в VS Code проверяет пользователь (F5)*
- [ ] Бейдж активных фильтров в заголовке view (`TreeView.description`, например «2 фильтра · GARM») — *формат строки покрыт тестами (`describeFilters`); показ в заголовке view — пользователь*
- [ ] `filtersTree.ts`: группы «Мои» (локальные) и «Избранные в Jira» (по инстансам); клик → режим JQL с этим запросом; `saveFilter`, `deleteFilter` — *`favouriteFilters` проверен на живых pilot/sccloud через smoke; дерево и команды — пользователь (F5)*
- [ ] `openIssueByKey`: ключ → инстанс по префиксу проекта (кэш проектов инстанса), иначе QuickPick инстанса — *сопоставление префикса покрыто тестами (`matchInstancesByKey`); команда — пользователь (F5)*
- [ ] Клик по задаче вызывает `jiraffe.openIssue` (пока заглушка: `showInformationMessage`) — *пользователь (F5)*

**Готово, когда:** тесты `jql.test.ts` зелёные, `npm run build && npm run lint && npm test`
проходят. Smoke дополнительно выполняет `buildJql` для режимов «на мне» и «проект GARM» и печатает
счётчики. Пользователь по F5 видит свои задачи в трёх инстансах, переключает режимы и фильтры.

**Сессия:** sonnet, high; после этапа 2.

**Решения (2026-10-04, по итогам сессии 3):**
- Раскладка — как в «Архитектуре»: `src/jql.ts`, `src/state/filters.ts`, `src/views/{issuesTree,filtersTree}.ts`, `test/{jql,filters}.test.ts`. Вне списка (по необходимости): `src/commands/filters.ts` (все команды этапа, чтобы не раздувать `extension.ts`), `src/state/meta.ts` (`InstanceMeta`: кэш проектов/типов/приоритетов на инстанс + `client(inst)` — фабрика клиента с токеном из SecretStorage; кэш сбрасывается по `store.onDidChange` и по `jiraffe.refresh`, ошибки не кэшируются), `src/state/query.ts` (`jqlForInstance`), `src/views/format.ts` (чистые функции: иконки, tooltip, подпись счётчика). Всё без `import vscode`, поэтому тестируется в vitest; vscode — только в `views/*`, `commands/*`, `extension.ts`. `jiraffe.refresh` переехала из `extension.ts` в `registerFilterCommands` (сбрасывает кэш справочников, перечитывает задачи и избранные фильтры).
- Контракт `buildJql({mode, projectKey, jql, quick:{statusCategory,types,priorities}, text})`: категории — **по id** (`statusCategory in (1, 2, 4)`: new=1,2 (1 — «без категории», маппер и так показывает её как «Открыта»), done=3, indeterminate=4), а не по именам: имена локализуются. Проверено на 4 живых инстансах: сумма трёх категорий равна размеру проекта. Ключ в тексте → `(key = ABC-123 OR text ~ "…")` (*приёмка*, см. ниже), иначе `text ~ "…"` (экранируются сначала операторы Lucene, затем `\` и `"` для JQL; переводы строк — в пробел). В режиме `jql` пользовательский `ORDER BY` (вне кавычек) сохраняется и ставится в конец, остальное оборачивается в скобки, если есть что приклеить; пустой JQL даёт только `ORDER BY`. Ключ проекта без кавычек, если он `[A-Z][A-Z0-9_]*`.
- Отступления от формулировки плана, которые стоит знать:
  - **«Готово» в быстром фильтре в режиме «на мне» снимает `resolution = Unresolved`** — иначе «на мне» + «Готово» всегда пусто. Остальные категории его оставляют.
  - **Типы и приоритеты сужаются до существующих на инстансе** (`jqlForInstance`): неизвестное значение Jira отвергает 400, а набор типов разный. Если из выбранного на инстансе ничего нет — запрос не уходит, список пуст. Не загрузился справочник — берём выбор как есть. Выбор типов/приоритетов в QuickPick — объединение по всем инстансам, сравнение без учёта регистра.
  - **Режим «проект» и «JQL из фильтра» привязаны к одному инстансу**: проект хранится как `{instanceId, key}` (ключ может совпасть на разных инстансах); фильтр (локальный, сохранённый с привязкой, или избранный из Jira) ставит `jqlScope` и опрашивает только его инстанс — чужой JQL на других инстансах дал бы ошибки. JQL, введённый вручную, идёт на все выбранные инстансы.
  - Дерево во всех режимах корневыми узлами показывает инстансы (в режиме «проект» — один), а не плоский список, как в прототипе: код единый, счётчик и ошибка живут на узле инстанса. Счётчик — в `description` узла (`host · 12`; Cloud — `N+`, пока есть следующая страница), плюс `TreeView.badge` — сумма найденного.
  - Каждый инстанс грузится независимо: узлы появляются сразу с «загрузка…», медленный или упавший не блокирует остальных; устаревший ответ (после смены фильтра) отбрасывается по счётчику поколений. «Загрузить ещё» дедуплицирует по ключу (выдача сдвигается между страницами).
  - Конвертация режима в JQL (*исправлено на приёмке*): `editJql` в режиме «на мне»/«проект» запекает в JQL только режим и категории статуса; типы, приоритеты, поиск и выбор инстансов остаются быстрыми фильтрами поверх запроса (они зависят от инстанса: запечённый тип, которого на инстансе нет, даёт 400). `saveFilter` сохраняет то, что видно на экране, и сразу применяет его; привязка к инстансу — проект, JQL из фильтра или единственный выбранный инстанс, тогда JQL собирается `jqlForInstance` (типы сужены). Без привязки — `buildJql` как есть (в нескольких инстансах с разными типами возможен 400 — ограничение).
  - Состояние фильтров (режим, проект, JQL, быстрые, текст, инстансы) переживает перезапуск (`globalState`, ключ `jiraffe.filterState`; локальные фильтры — `jiraffe.filters`); битое состояние отбрасывается при чтении.
  - Фильтры Jira без JQL (у Pilot один такой) в дереве не показываются.
  - Настройка `jiraffe.maxResults` (50, 1..100) добавлена в `package.json` сейчас — она нужна для страницы; остальные настройки — в своих этапах.
  - Команды сверх списка в «Архитектуре» (служебные, скрыты из палитры): `resetFilters` (в палитре виден), `applyFilter`, `loadMore`; `deleteFilter` скрыта из палитры, доступна из контекстного меню «Мои». Кнопки в заголовке «Задач»: поиск, быстрые фильтры, режим, обновить; остальное — в меню «…». `viewsWelcome` для пустого списка инстансов — кнопка «Добавить инстанс».
  - `jiraffe.testConnection` принимает необязательный `instanceId` (узел ошибки инстанса вызывает её с аргументом); из палитры работает как раньше.
- *Приёмка (Opus, два прохода), исправлено:*
  - **Поиск по тексту:** операторы Lucene (`+ - & | ! ( ) { } [ ] ^ " ~ : \ /`) экранируются (`luceneEscape` в `jql.ts`), `*`/`?` остаются подстановками, отдельные `AND/OR/NOT` — в нижний регистр. Было: `[UI] кнопка`, `foo(`, `foo!`, `x AND` давали 400 на всех DC (проверено на живых), `-bar`/`title:foo` меняли смысл. Smoke JQL-режима теперь ищет `a "quoted" \ word [UI] C++ foo! 5" AND x\` — принято всеми четырьмя.
  - **Текст вида ключа:** `UTF-8`/`ISO-9001` всегда уходили как `key = …` и не находились. Теперь `jqlForInstance` ищет как ключ только там, где есть проект с этим префиксом: `(key = X OR text ~ "x")`, на остальных — только текст; справочник не загрузился — текст. На DC `key = GARM-99999999` (проект есть, задачи нет) — 400 (проверено), поэтому `IssuesTree.load` при 400 и ключевом тексте повторяет запрос текстом.
  - Ошибка 400 (ошибка в запросе) — узел ошибки без действия «Проверить подключение», подсказка «поправьте JQL или фильтры». Cloud на JQL без условий (`ORDER BY …`) отвечает понятным 400 «Неограниченные запросы JQL здесь не допускаются» — оставлено как есть.
  - `editJql`/`saveFilter` теряли выбор инстансов (`clearQuick` чистил `instances`) и запекали типы без сужения — см. «Конвертация» выше; `setJql(…, {baked: 'all' | 'categories'})`.
  - Удалённый инстанс в проекте/привязке фильтра: «Сбросить фильтры» теперь снимает мёртвые `project`/`jqlScope` (`reset(existingIds)`), `editJql` не сохраняет мёртвую привязку, подсказки в дереве различают «выберите проект» и «выберите фильтр».
  - Список локальных фильтров — отдельное событие `onDidChangeSaved`: сохранение/удаление фильтра больше не перезагружает дерево задач (терялись догруженные страницы).
  - Счётчик в заголовке не считает выбор инстансов там, где он не действует (режим «проект», JQL из фильтра); в QuickPick быстрых фильтров группа «Инстанс» там скрыта, выбор сохраняется. Тултип бейджа на Cloud — «не меньше N». `splitOrderBy` находит `ORDER BY` вплотную после кавычки. `InstanceMeta` диспозится. `applyFilter` без аргумента не падает.
  - Не исправлено (осознанно): устаревшие запросы не отменяются (`AbortController`), их ответы отбрасываются по поколению — лишний трафик при частой смене фильтров, порчи данных нет.
- Контракт для следующих этапов: `jiraffe.openIssue` — заглушка в `src/commands/filters.ts`, аргумент `IssueRef {instanceId, key}` (экспорт из `views/issuesTree.ts`); `jiraffe.openIssueByKey(key?)` сам определяет инстанс и вызывает `openIssue`. `InstanceMeta` (проекты/типы/приоритеты с кэшем) пригодится этапам 4 и 7 вместо собственных запросов.
- Smoke: вторая таблица по четырём инстансам: число проектов, типов, приоритетов, избранных фильтров и счётчики JQL из `buildJql` — «на мне», «проект» (GARM на Pilot, на остальных первый проект), быстрые фильтры + текст, «Готово» (с разбивкой по трём категориям — инвариант «сумма = весь проект» валит smoke), режим `jql` со спецсимволами в тексте. Прогон 2026-10-04: все запросы приняты серверами, ошибок нет; pilot: 44 проекта, GARM 896 задач, «на мне» 159; sccloud: «на мне» 76; tatikoma: 186; Cloud: 69. Отдельно (разово, вне smoke) избранные фильтры pilot и sccloud обёрнуты в `buildJql` режима `jql` и выполнены: все приняты.
- **Не проверено (пользователь):** всё, что требует VS Code (F5): отрисовка деревьев «Задачи»/«Фильтры», иконки и цвета категорий, tooltip, бейдж и подпись в заголовке, QuickPick быстрых фильтров (разделители, мультивыбор), InputBox JQL/поиска, меню «…» и inline-кнопка удаления фильтра, `viewsWelcome`, «Загрузить ещё», клик по узлу ошибки, `openIssueByKey` с несколькими инстансами, сохранение состояния между перезапусками. Cloud-пагинация «Загрузить ещё» (курсор) на живом Cloud не проверялась (только мок этапа 2).
- **Чеклист F5:** (1) добавить инстансы — в «Задачах» узлы с `host · N`, задачи с цветной иконкой; (2) «Режим» → «Проект» → выбрать проект, список сменился; (3) «Быстрые фильтры» — выбрать «В работе» + тип, в заголовке «2 фильтра · KEY», «Сбросить фильтры»; (4) «Поиск» словом и ключом `ABC-123` — появилась строка «Открыть … по ключу»; (5) «Редактировать JQL» → правка → выполняется; «Сохранить как фильтр» → появился в «Мои», клик применяет, корзина удаляет; (6) «Избранные в Jira» по инстансам, клик применяет; (7) сломать токен инстанса — узел ошибки, клик → «Проверить подключение» без вопроса про инстанс; (8) клик по задаче — сообщение-заглушка.
- **Приёмка (2026-10-04, Opus, два прохода):** принят с оговорками: всё видимое — F5 у пользователя. `npm run build && npm run lint && npm test && npm run package` зелёные, 130 тестов (122 у исполнителя, 8 добавила приёмка: Lucene-экранирование, ключ vs текст по инстансу, `textAsKey`, `ORDER BY` после кавычки, `reset(existing)`, `baked`, раздельные события, счётчик инстансов). `npm run smoke` после правок: все запросы приняты четырьмя серверами, инвариант категорий держится (с id 1 в «Открыта»).

### 4. Карточка задачи
Webview-вкладка карточки: шапка, вкладки «Описание», «Комментарии», «История», «Журнал работ»
(только чтение), правая колонка мета-данных. Вложения и картинки — этап 5.

- [x] `client.issue(key, 'renderedFields,changelog')`, `watchers(key)`, `worklogs(key)` и маппинг в `IssueDetail`/`Worklog` (Epic через `instance.epicLinkField ?? caps.epicLinkField` на DC или `parent` с `hierarchyLevel===1` на Cloud) — тесты + smoke на 4 живых инстансах
- [x] `src/panels/html.ts`: каркас с CSP (`default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-…'`), подключение `dist/webview/issue.js` и `dist/webview/common.css` (тест на CSP дословно)
- [x] `src/panels/protocol.ts`: `host→view: {type:'issue', data}`, `{type:'loading'}`, `{type:'error', message}`; `view→host: openIssue, openEpic, openRelease, openInBrowser, copyKey, logWork, pin, switchTab` (+ служебные `ready`, `openExternal`)
- [ ] `IssuePanelManager` (код написан, собирается, lint чист; **не отмечено: поведение проверяет пользователь по F5**): одна preview-панель переиспользуется; `pin` переводит текущую в закреплённые; повторное открытие закреплённой фокусирует её; `retainContextWhenHidden: false`, состояние вкладки через `setState` + хост
- [ ] `webview/issue.ts` + `render.ts` + `common.css`: разметка из прототипа, цвета через `--vscode-*` (сборка, lint и тесты рендера зелёные; **не отмечено: вид в светлой и тёмной теме — пользователь**)
- [x] Описание и комментарии санитизируются в хосте (`sanitize-html`, `src/jira/sanitize.ts`; проверено на реальном HTML 2 живых инстансов и тестами на XSS). Ссылки — через `openExternal` (http/https/mailto), `img` — плейсхолдер «картинка — этап 5»
- [ ] Кнопки шапки: «Ключ» (копировать), «Открыть в Jira», «Залогать время» (заглушка), «Закрепить»; ссылки эпика и релиза шлют сообщения в хост, команды `jiraffe.openEpic/openRelease/logWork` — заглушки (**не отмечено: нажатия в VS Code — пользователь**)
- [x] `test/mappers.issue.test.ts`: фикстура DC из живого ответа Pilot (обезличена) → `IssueDetail`, включая changelog «было → стало»

**Готово, когда:** тесты зелёные, `npm run build && npm run lint && npm test` проходят.
Пользователь (F5) открывает GARM-задачу из дерева: видны описание, комментарии, история и журнал;
вторая задача открывается в той же вкладке, после «Закрепить» — в новой; карточка читается в
светлой и тёмной теме.

**Сессия:** sonnet, high (эталон разметки — прототип); после этапа 3.

**Решения (2026-10-04, по итогам сессии 4):**
- Раскладка: `src/jira/{mappers,client}.ts` (дополнены: `mapIssueDetail`, `mapEpic`, `epicFieldOf`, `mapHistory`, `mapWorklog`; `client.watchers/worklogs/issueDetail`), `src/jira/sanitize.ts` (новый, `sanitizeJiraHtml`/`sanitizeDetail`), `src/panels/{html,protocol,card,issuePanel}.ts`, `src/commands/issue.ts` (команды карточки), `webview/{issue,render}.ts` + `webview/common.css`, `test/{mappers.issue,panels}.test.ts`, `test/fixtures/issue-dc.json`. Вне списка «Архитектуры»: `card.ts` (сборка данных карточки без vscode — тестируется), `commands/issue.ts`, `webview/render.ts` (чистые «данные → HTML-строка», тестируются без DOM). `jiraffe.openIssue` по-прежнему регистрируется в `commands/filters.ts`, но тело — `panels.open(ref)`; в `registerFilterCommands` добавлен последний параметр `panels`.
- Протокол host↔webview (`src/panels/protocol.ts`): `host→view` — `loading {instanceId, key}`, `error {instanceId, key, message}`, `issue {data: IssueCard}`; `view→host` — `ready` (webview готов принимать, хост шлёт состояние; нужно из-за `retainContextWhenHidden:false`), `openIssue {key}` (ещё и «Повторить» при ошибке), `openEpic {key}`, `openRelease {id}`, `openInBrowser {key}`, `copyKey {key}`, `logWork {key}`, `pin {key}`, `switchTab {key, tab}` (key — задача, показанная в виде; не совпал с текущей — хост игнорирует), `openExternal {url}` (хост пускает только http/https/mailto, `safeExternalUrl`). Ключи/id из webview — `isIssueKey`/`isVersionId` (`protocol.ts`). `IssueCard` = `{instanceId, instanceName, host, kind, tempo, issue: IssueDetail (HTML санитизирован), worklogs, worklogError?, pinned, tab}`; вкладки `ISSUE_TABS = ['desc','com','hist','wl']` (этап 5 добавляет `att`). Вкладка хранится и в хосте (`switchTab`), и в `setState` webview (`{instanceId, key, tab}`): для той же задачи побеждает локальное состояние, для другой — вкладка из хоста (новая задача в preview всегда начинается с «Описания»).
- Действия карточки хост вызывает **командами**: `jiraffe.logWork(IssueRef)`, `jiraffe.openEpic({instanceId, key})`, `jiraffe.openRelease({instanceId, id})` — сейчас заглушки с сообщением «появится в этапе 6/7» в `src/commands/issue.ts`; этапы 6/7 меняют только тело. Заодно зарегистрированы `jiraffe.pinIssue / copyKey / openInBrowser` (из «Архитектуры»; без аргумента работают с активной карточкой или preview).
- Данные: карточка = 3 параллельных GET (`issue?expand=renderedFields,changelog`, `/watchers`, `/worklog`) + (DC) один GET названия эпика. `watchers`/`worklog` с 403/404 дают пустой список (нет прав на просмотр — карточка не падает); название эпика — best effort. Cloud: название эпика берётся из `parent.fields.summary` (проверено live: у parent есть `issuetype.hierarchyLevel`). Комментарии: HTML из `renderedFields.comment` по id, без него — экранированный plain. История: новые сверху, шум changelog (`WorklogId`, `timespent`, `timeestimate`, `timeoriginalestimate`) отброшен; «создал(а) задачу» дописывается синтетически (Jira не пишет создание в changelog). Changelog на Cloud/DC в `expand` ограничен тем, что отдал Jira (до 100 записей) — догрузки страниц нет. Журнал — стандартный `/issue/{key}/worklog` без догрузки страниц, новые сверху; Tempo-атрибуты — этап 6.
- Санитизация (`sanitize-html`, единственная новая runtime-зависимость, + `@types/sanitize-html` в devDeps): белый список расширен относительно плана тем, что реально отдаёт Jira (`b`, `i`, `u`, `s`, `del`, `ins`, `sub`, `sup`, `hr`, `thead/tbody/tfoot/tr/th/td/caption`; `tt` → `code`; на живых данных выпал только `font`). Разрешены атрибуты: `a[href,title]`, `th/td[colspan,rowspan]`, `span[class=img-ph, data-src, title]`; **любые другие `class` вычищаются** (чтобы классы Jira не пересекались со стилями карточки). Схемы — http/https/mailto. Относительные ссылки резолвятся от origin (путь уже содержит context path). Пустые якоря `<a name>` удаляются. `img` → `<span class="img-ph" data-src="абсолютный URL">[картинка — этап 5]</span>`: этап 5 находит их по `.img-ph[data-src]` и заменяет на `data:`-картинку. В `.vsix` библиотека попала **в бандл** `dist/extension.js` (в нём только `require` встроенных модулей и `vscode`; node_modules в пакете нет), сборка `--no-dependencies` не менялась.
- CSP запрещает inline-стили, поэтому в разметке нет `style=`: цвет аватара и ширина полоски времени ставятся в `issue.ts` через CSSOM по `data-bg`/`data-w`. Картинки аватаров и иконки типов с инстанса не грузим (CSP не пускает чужие хосты): аватар — инициалы с цветом по хэшу id, иконки типа/приоритета — свои SVG по названию (en/ru эвристика: bug/ошибка, epic/эпик…; неизвестный тип — «задача», неизвестный приоритет — «средний»). Плашка статуса — по `statusCategory` (название статуса — как в Jira; в прототипе была 4-я «Ревью» — её в Jira нет).
- Отступления от прототипа/плана: (1) вкладки — 4 (без «Вложений», это этап 5), в шапке добавлена кнопка «Закрепить» (в прототипе её не было); (2) «Релиз» — все `fixVersions` ссылками (в прототипе одна); (3) крошка показывает ключ эпика, мета-строка «Эпик» — его название; (4) единый `tsconfig` (DOM-типы) не мешает хосту — не разносил; (5) `webview/common.css` собирается esbuild как второй вход webview-бандла (`dist/webview/common.css`), `.vscodeignore` уже пропускал `dist/webview/*.css`.
- Фикстура `test/fixtures/issue-dc.json` собрана из живого ответа Pilot DC скриптом-обезличивателем (структура, поля и формат дат — настоящие; ключ ABC-123/ABC-100, люди Ivan Petrov / Anna Smirnova / Oleg Sidorov, хост `jira.example.test`, e-mail `@example.test`, тексты описания/комментариев/ворклога синтетические; в тесте есть проверка, что рабочих хостов и имён в файле нет).
- Smoke (`npm run smoke`): добавлена таблица «карточка» (только GET; ключи не печатаются) — на всех 4 инстансах карточка собирается, санитизация проходит; эпик найден и с названием на Pilot, sccloud, tatikoma (DC, Epic Link) и Cloud (`parent`).
- **Приёмка (2026-10-04, Opus, два прохода):** принят с оговорками: всё видимое — F5 у пользователя (чекбоксы `IssuePanelManager`, вид карточки и кнопки шапки не отмечены, чеклист — `roadmap-mvp.pending.md` → «Проверить руками», этап 4). Исправлено приёмкой: (1) клик по ссылке открывал её дважды — у VS Code в iframe свой обработчик ссылок, `defaultPrevented` он не смотрит → `stopPropagation` в `webview/issue.ts`; (2) `data-src` плейсхолдера принимал любой адрес — подделанный `<span class="img-ph" data-src>` из HTML Jira, `javascript:`/`file:`/`data:` и **чужие хосты** (`!https://attacker/x.png!` → этап 5 отправил бы туда токен); теперь `data-src` только у картинок своего инстанса (origin + context path), чужие http(s) — ссылкой «[внешняя картинка]», входящие `span` теряют `class`/`data-src`; (3) сообщения view→host: `openIssue`/`openEpic` — `isIssueKey`, `openRelease` — `isVersionId`, действия `pin/copyKey/openInBrowser/logWork/switchTab` несут `key` и игнорируются из устаревшего вида preview; `loading`/`error` несут `instanceId`, состояние webview — `{instanceId, key, tab}` (тот же ключ на другом инстансе не путается); фильтр ссылок вынесен в чистую `safeExternalUrl` (`protocol.ts`) с тестами; (4) `jiraffe.openIssue`/`openIssueByKey` проверяют ключ, regex ключа один (`ISSUE_KEY_RE` в `src/jql.ts`); (5) любая ошибка `/watchers`/`/worklog` (не только 403/404) больше не роняет карточку: наблюдатели — пусто, журнал — пусто с текстом `IssueCard.worklogError`; (6) «Повторить» сразу показывает загрузку; (7) описание без `renderedFields` — экранированный plain; якоря `#…` теряют `href`, относительный путь без `/` резолвится от baseUrl; (8) тест обезличенности фикстуры — белый список (хосты `example.test`, ключи `ABC`, три выдуманных имени) вместо перечня настоящих имён в исходнике. Проверено: `npm run build && npm run lint && npm test && npm run package` зелёные, 164 теста (130 прошлых этапов — не тронуты, 26 исполнителя, 8 приёмки); `.vsix` 8 файлов; `npm run smoke` после правок — карточка собирается на всех 4 инстансах, эпик с названием везде. Осталось осознанно: заголовок вкладки — ключ; `IssueCard.host`/`kind` в webview пока не используются; перерисовка `innerHTML` при смене вкладки сбрасывает прокрутку; `vscode.Uri.parse` может перекодировать `%2B` в query ссылки — проверить по F5.
- Не проверено: всё, что видно только в VS Code (F5): открытие из дерева, preview/закрепление, фокус закреплённой, скрытие/показ вкладки (ready → восстановление), светлая/тёмная/high-contrast темы, `color-mix` и `text-wrap: balance` в Chromium VS Code 1.90, клики по ссылкам, копирование ключа, заглушки сообщений. Панель не восстанавливается после перезапуска VS Code (serializer не регистрировали). Cloud-карточка не проверялась на задаче с картинками в комментариях; вложения в карточке не показываются (этап 5).


### 5. Вложения и картинки
Вкладка «Вложения» и картинки в описании: скачивание с авторизацией, превью, сохранение на диск,
открытие текстовых файлов в редакторе.

- [x] `client.downloadAttachment(url, maxBytes)` → `Uint8Array` + mime (тот же auth-заголовок; ответ больше лимита обрывается с ошибкой) — `HttpClient.getBinary`, тесты + smoke на 3 DC
- [ ] Превью: для картинок `thumbnailUrl` (если есть), иначе контент до `jiraffe.maxImageMb`; в webview передаются `data:` URI порциями (сообщение `attachmentPreview {id, dataUri}`), а не всё сразу (код написан; скачивание превью и тип по сигнатуре — smoke sccloud/tatikoma; **не отмечено: показ в карточке — пользователь, F5**)
- [x] Картинки в описании: в `descriptionHtml` хост находит `img src`, относящиеся к инстансу (`/secure/attachment/…`, `/secure/thumbnail/…`, абсолютные на тот же хост), скачивает и подменяет на `data:`; чужие хосты → ссылка вместо картинки (CSP их не пустит) — подмена и проверка адреса — тесты, скачивание картинки описания — smoke sccloud/tatikoma; вид — пользователь
- [ ] Вкладка «Вложения»: сетка как в прототипе (`.att-grid`), лайтбокс, кнопки «Скачать», «Скачать все», «Открыть в редакторе» (текстовые mime и `.log/.json/.txt/.xml/.csv` → `openTextDocument` из сохранённого файла) (разметка — тесты рендера; **не отмечено: клики и вид — пользователь, F5**)
- [ ] Сохранение в `<workspace>/.jiraffe/<KEY>/<filename>` (нет workspace → `os.tmpdir()/jiraffe/<KEY>`); защита имени файла от `..` и `/`; повторное скачивание перезаписывает (чистая часть — имя, путь, корень — тестами; **не отмечено: запись на диск из VS Code — пользователь, F5**)
- [x] `test/attachments.test.ts`: подмена `img src` (свои/чужие хосты, context path), санитизация имени файла, лимит размера

**Готово, когда:** тесты зелёные, сборка и линт проходят. Smoke скачивает одно вложение
(первое найденное у задачи с вложениями из `assignee = currentUser()`) в tmp и печатает размер —
это только GET. Пользователь видит скриншоты из задачи прямо в карточке.

**Сессия:** opus, high — авторизованные загрузки, CSP и санитизация, тут нужно суждение; после
этапа 4.

**Решения (2026-10-04, по итогам сессии 5):**
- Раскладка: `src/jira/http.ts` (+ `isOwnUrl`, `HttpClient.getBinary`, коды `JiraError` `'blocked' | 'limit'`), `src/jira/client.ts` (+ `downloadAttachment`), **новый** `src/jira/attachments.ts` (чистый, без vscode: `safeFileName`, `attachmentFileNames`, `attachmentUrls`, `attachmentPath`, `resolveAttachmentsRoot`, `sniffImage`, `isImageAttachment`/`isTextAttachment`/`looksLikeText`, `extractInlineImages`, `LruCache`, `limiter`), **новый** `src/panels/attachments.ts` (`AttachmentService` с vscode: кэш картинок, сохранение, «Скачать все», «Открыть в редакторе», очистка tmp), `src/panels/{card,protocol,issuePanel}.ts`, `src/commands/issue.ts` (`jiraffe.downloadAttachment`), `src/extension.ts`, `src/jira/sanitize.ts` (текст плейсхолдера `[картинка]`), `webview/{issue,render}.ts`, `webview/common.css`, `package.json` (команда + настройки `jiraffe.attachmentsDir`, `jiraffe.maxImageMb`), `scripts/smoke.ts`, `test/attachments.test.ts` (+ правки `test/{panels,mappers.issue}.test.ts` под 5 вкладок и новый текст плейсхолдера).
- `loadCard` возвращает `LoadedCard {card, files, inlineUrls}`: `card` уходит в webview **без адресов Jira** (`issue.attachments = []`, вложения — `IssueCard.attachments: AttachmentView[]` без `contentUrl/thumbnailUrl`, с подсказками `image`/`text`; в HTML картинки — `span.img-ph[data-img="iN"]`), `files` и `inlineUrls` живут только в `Entry` хоста.
- Протокол (дополнение к этапу 4): `ISSUE_TABS = ['desc','att','com','hist','wl']`. `host→view`: `attachmentPreview {instanceId, key, id, dataUri?, error?}` — по одной картинке. `view→host`: `loadImages {instanceId, key, ids[]}` (≤200, `isImageId`: `iN` — картинка описания/комментария по номеру в таблице хоста, `tID` — превью вложения, `fID` — вложение целиком для лайтбокса), `downloadAttachment {instanceId, key, id}`, `downloadAll {instanceId, key}`, `openAttachment {instanceId, key, id}` (`isAttachmentId` — только цифры). Хост принимает их, только если `instanceId` и `key` совпали с показанной задачей и карточка загружена (`ATTACHMENT_ACTIONS` в `issuePanel.ts`); ответы для устаревшей карточки (сменился `seq`) отбрасываются. Webview сам просит картинки, которые есть в отрисованной вкладке (лениво: комментарии — когда открыли вкладку), держит их в памяти до следующего `issue`, вставляет через DOM (`createElement('img')`) и только если строка — `data:image/…;base64,…`.
- Безопасность токена: `getBinary` принимает только адрес инстанса (`isOwnUrl`: http(s), тот же origin, путь под context path, без `user:pw@`), иначе `blocked` без запроса — и для `data-src` описания (проверка повторяется в `extractInlineImages`), и для `contentUrl`/`thumbnailUrl` (если Jira отдала ссылку на другой хост — адрес пересобирается из `baseUrl` + числового id, иначе не качаем). Редиректы ведём сами (`redirect: 'manual'`, до 5): `Authorization` — только на адреса инстанса; **на чужой origin идём только по https и без `Authorization`** — так работает Cloud (`/rest/api/2/attachment/content/{id}` → 303 на `api.media.atlassian.com` с подписанной ссылкой), токен Jira туда не уходит; на http-чужой — отказ; редирект на `login.jsp` — ошибка 401 «нет доступа», а не HTML вместо файла. Адреса редиректов (в них свой токен media) в сообщения не попадают, тексты ошибок проходят `scrub`.
- Лимиты: Content-Length сверх лимита — отказ до чтения, тело читается потоком и обрывается на лимите (`limit`). Картинки (превью, описание, лайтбокс) — `jiraffe.maxImageMb` (по умолчанию 5, зажат в 1..50; больше — «скачайте файл»); «Скачать» — жёсткий потолок 200 МБ (файл держится в памяти до записи), «Открыть в редакторе» — 50 МБ. Кэш картинок — в памяти хоста, LRU ~64 МБ data URI на все карточки, ошибки не кэшируются; одновременно ≤3 скачивания.
- Тип картинки — по сигнатуре (`sniffImage`: png/jpeg/gif/webp/bmp/ico, svg только с `<svg` в начале — в `<img>` скрипты SVG не исполняются), Content-Type ответа не используется. «Открыть в редакторе» показывается по расширению (`txt log json xml csv tsv md yaml yml ini conf cfg properties sql diff patch har`) или по mime из **метаданных Jira** (`text/*`, json, xml); после скачивания содержимое проверяется (`looksLikeText`: нет NUL в первых 64 КБ), бинарь не открывается. Открытие — только `openTextDocument` сохранённой копии; внешними программами не открываем (только «Показать в папке» — `revealFileInOS`).
- Сохранение: `<root>/<KEY>/<имя>`; `root` — `jiraffe.attachmentsDir` относительно первой папки workspace (не выше неё), без workspace — `<tmp>/jiraffe`; **абсолютный путь — только из пользовательских настроек** (настройка из `.vscode/settings.json` чужого репо не уведёт запись в `~/.ssh`; выход за workspace → `.jiraffe` + предупреждение). Имя — `safeFileName`: только последняя часть пути, без управляющих/bidi символов и `<>:"|?*`, без ведущих точек (нет `..` и dotfiles), без зарезервированных имён Windows, ≤180 байт; дубли имён в задаче (`image.png` ×N) получают ` (id)`, имя стабильно — повторное скачивание перезаписывает. Запись атомарная: временный `.part` (`wx`, 0600) → `rename` (симлинк на месте файла заменяется, а не «пробивается»); `root` и `<KEY>` не должны быть симлинками, свой tmp-каталог — принадлежать текущему пользователю (на Linux `/tmp` общий). `<tmp>/jiraffe` чистится при активации: папки задач старше 7 дней.
- CSP **не менялся**: `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-…'` — `data:` для картинок уже был. Inline-стилей нет (лайтбокс и сетка — классы в `common.css`).
- Как CSP и санитизация защищают от HTML из Jira: HTML описания/комментариев проходит `sanitize-html` в хосте (белый список тегов, атрибутов и схем; классы Jira вычищаются), `img` превращается в плейсхолдер — так HTML Jira не может ни выполнить скрипт (CSP пускает только скрипт с nonce), ни загрузить ресурс с чужого хоста (CSP `img-src` — только webview и `data:`), ни заставить хост качать произвольный адрес с токеном (`data-src` ставит только наш трансформ, адрес остаётся в хосте, webview знает лишь номер, хост дважды проверяет origin + context path).
- Отступления и решения сверх плана: (1) сообщение `attachmentPreview` несёт и картинки описания (`iN`), и полноразмерные картинки лайтбокса (`fID`) — один механизм; (2) картинки описания кликабельны — открываются в том же лайтбоксе (в прототипе лайтбокс был только у вложений), даже если Jira обернула картинку в ссылку; (3) **в `.jiraffe/` при первом сохранении пишется `.gitignore` с `*`** (только для настройки по умолчанию и только если файла нет) — чтобы вложения не уехали в git пользователя; (4) плейсхолдер картинки — `[картинка]` (было «[картинка — этап 5]»); (5) команда `jiraffe.downloadAttachment({instanceId, key, id})` работает с вложением открытой карточки (скрыта из палитры); (6) «Открыть в редакторе» тоже сохраняет файл в `.jiraffe/<KEY>/` (план: «из сохранённой копии»).
- Smoke (`npm run smoke`, только GET): таблица «вложения» — первая задача с вложениями из `assignee = currentUser()` (если нет — любая), первое вложение ≤20 МБ скачивается в `mkdtemp`, размер сверяется с метаданными, папка удаляется; превью картинки и первая картинка описания — тип по сигнатуре. Результат: pilot, sccloud, tatikoma — вложение скачано, размер совпал; sccloud и tatikoma (context path `/jira`) — превью и картинка описания `image/png`; на pilot у найденной задачи вложение не картинка; **на Cloud задач с вложениями нет — редирект на media-хост проверен только тестом с моком**.
- Не проверено: всё видимое в VS Code (F5) — вкладка «Вложения», превью, лайтбокс (Esc, клик по фону), картинки в описании/комментариях, «Скачать»/«Скачать все»/«Открыть в редакторе», уведомления и «Показать в папке», `.gitignore` в `.jiraffe`, работа без открытой папки (tmp), предупреждение про `attachmentsDir`; Cloud-вложения живьём; картинка описания, обёрнутая Jira в ссылку на миниатюру, в лайтбоксе показывается миниатюрой.

**Приёмка 5 (2026-10-04, два прохода: свой + независимый ревьюер):** исправлено — (1) ReDoS в распознавании SVG (регэксп с `(<!--…-->)*` экспоненциально откатывался на файле из сотен `<!---->` и вешал extension host при открытии карточки) → линейный `svgAtStart`, тест на время; (2) имена вложений и тексты ошибок в уведомлениях VS Code шли сырыми — там `[текст](command:…)` становится кликабельной ссылкой на команду → `noticeText` (скобки → `［］`, обрезка) во всех уведомлениях вложений; (3) цепочка редиректов, покинувшая инстанс, больше не получает `Authorization`, даже вернувшись на адрес инстанса; 3xx без Location — своя ошибка; http-инстанс → https того же хоста — ошибка «укажите https-адрес»; (4) лимит пикселей картинок для webview (`imageSize`/`imageRejection`: png/gif/bmp/webp/jpeg ≤ 50 Мпикс, SVG ≤ 1 МБ) — защита от decompression bomb; (5) длинные тёзки при обрезке до 180 байт теряли суффикс ` (id)` и писались в один файл — суффикс клеится после обрезки; (6) промежуточный каталог-симлинк в `attachmentsDir` из workspace (`docs -> ~`) — проверка realpath до `mkdir` и после; абсолютный путь из user-настроек может быть симлинком; (7) байты сохранённого файла не держатся, пока висит уведомление «сохранено» (`save` → `{file, shown, text}`), сохранения — не больше 2 одновременно; (8) картинки из очереди для закрытой/сменившейся карточки не качаются (`AttachmentContext.alive`); (9) `limiter` не теряет слот на синхронном throw; невидимые/«похожие на слэш» символы в имени; (10) `package.json`: явно `capabilities.untrustedWorkspaces.supported = false`. Оставлено как есть (низкий риск, записано): HTML страницы SSO на чужом https-хосте после редиректа сохраняется как файл (ловится только `login.jsp`); активное скачивание не прерывается при закрытии карточки (до 3 штук, таймаут); «Скачать» держит файл в памяти до записи (≤200 МБ ×2 на пике); таймаут 120 с на всё скачивание, а не на простой; при удалении более раннего тёзки имя ` (id)` у вложения меняется.

### 6. Журнал работ и Tempo
Запись времени из карточки и боковой панели, рабочие атрибуты Tempo с инстанса, сводка
«сегодня» в разделе Tempo и в строке состояния.

- [x] Проверить допущения о Tempo v3 по живому Pilot **только GET-запросами**: `/rest/tempo-core/1/work-attribute` (формат атрибутов) и чтение ворклогов (`/rest/tempo-timesheets/3/worklogs?dateFrom&dateTo&username`). Результат и реальные форматы записать в раздел «Допущения» этого файла (записано 2026-10-04)
- [x] `src/jira/tempo.ts`: `attributes()`, `worklogs({dateFrom, dateTo, username, issueKey?})` (если endpoint подтвердился), `addWorklog({issueKey, author, started, timeSpentSec, comment, attributes, remainingEstimateSec})` — payload как в `pilot-jira/jira.sh` `cmd_worklog` (чтение — тесты + smoke Pilot; `addWorklog` — тесты на моке fetch, **живая запись — пользователь**)
- [x] Стандартный путь: `client.addWorklog(key, {started, timeSpentSec, comment}, adjustEstimate)`; AI Tokens без Tempo → `(AI Tokens: N)` в конце комментария (тесты на моке; **живая запись — пользователь**)
- [ ] Форма «Залогать время» — webview-диалог в карточке (как `logHtml` в прототипе) и команда `jiraffe.logWork` (QuickInput: длительность → дата → комментарий → атрибуты) для вызова из дерева и палитры. Поля атрибутов строятся по ответу `work-attribute` (разметка диалога и проверка формы — тесты; **не отмечено: диалог и QuickInput в VS Code — пользователь, F5**)
- [x] `remainingEstimateSec` для Tempo = `max(remaining − spent, 0)` по `timetracking` задачи (допущение о поведении — см. «Риски»)
- [ ] После записи: обновить карточку (журнал, «Залогано»), дерево Tempo и строку состояния; сообщение `Залогано 1ч 30м в ABC-123 · Tempo` (код: `WorklogService.onDidLog` → `panels.reload` + `today.refresh`; **не отмечено: пользователь после живой записи**)
- [x] Сводка «сегодня»: Tempo-инстанс — `tempo.worklogs(today, me)`; без Tempo — JQL `worklogAuthor = currentUser() AND worklogDate = "YYYY-MM-DD"`, затем `worklogs(key)` и фильтр по автору и дате. Сумма по всем инстансам (тесты + smoke 4 инстанса; на Pilot оба пути дали одну сумму за прошедший день с записями)
- [ ] `tempoView.ts` (WebviewView): блок «Сегодня» из прототипа (`renderTempo`), без недельной таблицы; кнопка «Залогать»; `statusBar.ts`: `$(clock) Сегодня 3ч 15м / 8ч`, клик фокусирует раздел Tempo (разметка «Сегодня» и текст строки — тесты; **не отмечено: вид и клики — пользователь, F5**)
- [ ] Вкладка «Журнал работ» карточки: на Tempo-инстансе колонки атрибутов (если чтение Tempo подтвердилось), иначе без них (данные — smoke Pilot: атрибуты у ворклогов задачи нашлись; разметка — тесты; **не отмечено: вид — пользователь**)
- [x] `test/worklog.test.ts`: payload Tempo (атрибуты, `remainingEstimateSeconds`, `dateStarted` без зоны), payload стандартный (`started` с локальным смещением, AI Tokens в комментарии), сумма «сегодня»

**Готово, когда:** тесты зелёные, сборка и линт проходят. В smoke добавлены атрибуты Pilot и
сумма «сегодня» по каждому инстансу — только GET. **Запись проверяет пользователь:** одна запись
в Pilot (Tempo с AI Tokens) и одна в sccloud, обе видны в Jira и в карточке.

**Сессия:** opus, high — непроверенные endpoint'ы и запись в рабочие Jira; после этапа 5.

**Решения (2026-10-04, по итогам сессии 6):**
- Раскладка: `src/jira/http.ts` (+ `HttpClient.postJson`), `src/jira/client.ts` (+ `addWorklog`, `timetracking`), **новые** `src/jira/tempo.ts` (`TempoClient`: `attributes`, `worklogs`, `worklog(id)`, `addWorklog`; `tempoPayload`, `mapWorkAttribute`, `mapTempoWorklog`, `findAiTokensAttr`, `withTempoAttributes`) и `src/jira/worklog.ts` (чистые: `logFormFor`, `validateDraft`, `startedWithOffset`, `appendAiTokens`, `remainingAfter`, `submitWorklog`, `loadToday`, `mineOn`, `sumToday`, `localDate`), `src/state/meta.ts` (+ кэш `myself`, `workAttributes`), **новые** `src/state/today.ts` (`TodayService`, `statusBarText/Lines`, без vscode), `src/commands/logWork.ts` (`WorklogService` + `jiraffe.logWork` + QuickInput), `src/views/{tempoView,statusBar}.ts`, `webview/{today,tempo}.ts` (третий вход webview-бандла `dist/webview/tempo.js`), правки `src/panels/{protocol,card,issuePanel}.ts`, `src/commands/{issue,filters}.ts`, `src/extension.ts`, `webview/{issue,render}.ts`, `webview/common.css`, `esbuild.mjs`, `package.json`, `scripts/smoke.ts`, `test/worklog.test.ts`. Вне списка «Архитектуры»: `worklog.ts`, `today.ts`, `commands/logWork.ts`, `webview/{today,tempo}.ts`.
- `HttpClient.postJson(path, body, query?)`: адрес — только `baseUrl`+путь и обязан пройти `isOwnUrl` (`/../` за context path → `blocked` без запроса); `redirect: 'manual'`, **любой 3xx — ошибка** (`login.jsp` → 401, иначе `redirect`), по Location не идём: тело записи и `Authorization` никуда не уходят, а `fetch` на 302/303 превратил бы POST в GET. Таймаут/обрыв/не-JSON после отправки — текст «запись могла сохраниться — проверьте журнал задачи, прежде чем повторять»; `scrub` как у GET, тело запроса в сообщения не попадает. Пустой ответ (204) → `undefined`.
- Payload'ы (тесты на моке fetch, живьём POST **не выполнялся ни разу**): **Tempo** — `POST /rest/tempo-timesheets/3/worklogs/` `{issue:{key, remainingEstimateSeconds}, author:{name:<login из /myself>}, timeSpentSeconds, dateStarted:"YYYY-MM-DDT12:00:00.000" (без пояса), comment?, worklogAttributes?:[{key,value}]}` — как `cmd_worklog`; пустые атрибуты и пустой комментарий не шлются. `remainingEstimateSeconds = max(remaining − spent, 0)` по **свежему** `GET issue?fields=timetracking` прямо перед записью (нет оценки → 0, как скрипт). **Стандартный** — `POST /rest/api/2/issue/{key}/worklog?adjustEstimate=leave` `{started:"YYYY-MM-DDT12:00:00.000+HHMM" (локальное смещение на ту дату), timeSpentSeconds, comment?}` (Cloud — тот же v2-путь, комментарий строкой). Время записи — полдень выбранного дня (как в скриптах): дата не съезжает ни при каком поясе сервера. AI Tokens: на Tempo — атрибут `_AITokensUsed_` (или атрибут с именем «AI Tokens»), если его нет — `(AI Tokens: N)` в комментарий, как и без Tempo; N — целое без разделителей.
- Проверка формы — в хосте (`validateDraft`, значения из webview недоверенные): длительность — `parseDuration`, не больше 24 ч (как прототип); дата — существующая `YYYY-MM-DD`, 2000–2100; комментарий ≤ 30 000; AI Tokens — цифры (пробелы-разделители допустимы); атрибуты — только ключи из `work-attribute` инстанса, число — `-?\d+([.,]\d+)?`, список — только его значения, флажок → `"true"`/не шлётся; обязательные пустые — ошибка с полем (`attr:<key>`). Типы `ACCOUNT`/`DYNAMIC_DROPDOWN`/`BILLABLE_SECONDS` форма не рисует; обязательный такой — заметка в форме/предупреждение (Tempo отклонит запись — ошибку покажем как есть). Не загрузились атрибуты Tempo — форма не открывается (ошибка), чтобы AI Tokens молча не ушли в комментарий вместо атрибута. Одновременно — одна запись в задачу (`inFlight`).
- Протокол (дополнение): `host→view` `logForm {instanceId, key, form: LogFormView}` (`LogForm` + `instanceName`, `summary`, `today`) и `logResult {instanceId, key, ok, field?, error?}`; `view→host` `submitWorklog {instanceId, key, draft: LogDraft}` — в наборе `ATTACHMENT_ACTIONS` (instanceId и key сверяются с показанной задачей, карточка загружена). `IssueCard.workAttributes?: WorkAttribute[]` — колонки журнала. Раздел Tempo — свой протокол `HostToTempo {type:'today', data: TodayView}` / `TempoToHost` (`ready`, `openIssue {instanceId, key}` — инстанс должен существовать, ключ — `isIssueKey`; `logWork`, `refresh`, `addInstance`).
- Точка входа — **команда `jiraffe.logWork(arg?)`** (`commands/logWork.ts`): аргумент — `IssueRef` или узел дерева «Задачи» (контекстное меню `viewItem == issue`), без аргумента — активная/preview карточка, нет её — InputBox ключа (`pickIssueRef`, вынесен из `openIssueByKey` в `commands/filters.ts`). Если карточка задачи открыта и загружена — вкладка выводится вперёд и в ней открывается webview-диалог (`IssuePanelManager.showLogForm`; кнопка карточки шлёт `logWork` → хост вызывает команду), иначе QuickInput: длительность → дата (Сегодня/Вчера/Другая) → комментарий → AI Tokens → прочие атрибуты. `IssuePanelManager` получил **5-й параметр `WorklogService`** и методы `activeRef`, `showLogForm`, `reload`. Диалог живёт в `#dlg` вне `#app` — перерисовка карточки (обновление данных) введённое не теряет; при смене задачи в preview закрывается. Скрытая карточка (`retainContextWhenHidden:false`) сбрасывает `ready` в `onDidChangeViewState` — диалог досылается после нового `ready`.
- После записи `WorklogService.onDidLog` → `panels.reload(ref)` + `today.refresh()`; то же после неоднозначной ошибки (сеть/таймаут), чтобы было видно, прошла ли запись. Уведомление `Jiraffe: Залогано 1ч 30м в ABC-123 · Tempo` (`· журнал Jira`; не сегодня — ` за YYYY-MM-DD`), через `noticeText`. Webview после успеха закрывает диалог и переключается на «Журнал работ» (как прототип).
- Журнал карточки на Tempo-инстансе: стандартный `/worklog` (Tempo-ворклоги там есть) + атрибуты `GET tempo-timesheets/3/worklogs/{id}` по каждому (новые первыми, до 50, параллельно 4; 401/403/сеть — прекращаем, 404 — строка без атрибутов; best effort, карточку не роняет) + описания атрибутов (`meta.workAttributes`, кэш). Колонки — атрибуты инстанса + ключи, встреченные в данных; список — название значения, число — с разрядами и суммой в «Итого». Строка «Tempo Timesheets · атрибуты «…»».
- «Сегодня»: `TodayService` (все инстансы параллельно, упавший — строка с ошибкой, устаревший ответ отбрасывается по поколению; смена даты сбрасывает старые записи). Tempo — `worklogs(dateFrom=dateTo=сегодня, username=логин)`; без Tempo (и Cloud) — JQL `worklogAuthor = currentUser() AND worklogDate = "YYYY-MM-DD"` (до 100 задач) → `/worklog` каждой (параллельно 3) → автор = я (`name` DC / `accountId` Cloud) и префикс даты `started`. Обновляется: при активации, после записи, по `jiraffe.refresh` (у `registerFilterCommands` 7-й параметр `onRefresh`), при изменении инстансов, при возврате фокуса окну (не чаще раза в 5 мин) и раз в 15 мин, пока окно в фокусе. Строка состояния `$(clock) Сегодня 3ч 15м / 8ч` (до загрузки — «…», ошибка инстанса — `$(warning)`), tooltip — по инстансам обычным текстом (не markdown), клик — `jiraffe.tempo.focus`; без инстансов скрыта. Настройка `jiraffe.workdayHours` (8, 1..24).
- Раздел Tempo: «Сегодня, <день недели, число месяц>», сумма, «из 8ч · осталось», полоска (ширина — CSSOM), строки «ключ · комментарий · время» (клик/Enter — карточка), ошибки инстансов, кнопки «Обновить» и «Залогать»; в заголовке view — «Залогать время» и «Обновить». Без инстансов — кнопка «Добавить инстанс». Недельной таблицы и кнопки «Неделя» нет (вне MVP).
- Smoke (`npm run smoke`, только GET): таблица «Tempo» — атрибуты Pilot (`AI Tokens [_AITokensUsed_, INPUT_NUMERIC]`), ворклоги Tempo за 14 дней и сколько с атрибутами, атрибуты в журнале карточки (стандартный `/worklog` + Tempo по id) и доля Tempo-ворклогов, найденных в `/worklog`, «сегодня» по каждому инстансу, на Tempo — ещё и через JQL-путь (сравнение), строка «ВСЕГО». Прогон 2026-10-04: все 4 инстанса без ошибок; сегодня (воскресенье) везде 0м; разово (вне smoke) за последний день с записями: Pilot — Tempo-путь и JQL-путь дали одну сумму, Cloud — JQL-путь нашёл запись; у sccloud/tatikoma записей за 30 дней нет — путь проверен только на 0 и тестами.
- Отступления: (1) `TempoClient.addWorklog` принимает `date` (`YYYY-MM-DD`), а не `started` — время всегда полдень; (2) `worklogs({…, issueKey})` фильтрует на клиенте — сервер фильтр по задаче игнорирует; (3) `jiraffe.logWork` теперь видна в палитре и в контекстном меню задачи дерева (была скрыта); (4) `activationEvents: ["onStartupFinished"]` — см. «Скоуп» в отчёте; (5) поле «Потрачено» в диалоге пустое с подсказкой «1ч 30м» (в прототипе было предзаполнено «1ч 30м» — так легко залогать полтора часа случайно); (6) в QuickInput AI Tokens спрашивается всегда (4-й шаг), прочие атрибуты Tempo — после него.
- Не проверено: **любая живая запись** (Pilot/Tempo с AI Tokens, sccloud, Cloud) — пользователь; ответ Tempo на POST (берём `id` из объекта или первого элемента массива — по скрипту); поведение `adjustEstimate=leave` и пересчёт остатка в Tempo; всё видимое в VS Code (диалог в карточке, QuickInput, раздел Tempo, строка состояния и клик по ней, контекстное меню дерева, обновление карточки после записи, светлая/тёмная тема диалога); атрибуты `STATIC_LIST`/`INPUT_FIELD`/`CHECKBOX` — только тесты (на Pilot их нет); `<input type="date">` в webview VS Code.
- Ревью (2026-10-04, два прохода): (1) `WorklogService.inFlight` ставится до первого `await` — раньше два сообщения подряд оба проходили проверку и давали дубль; (2) неоднозначные ошибки записи помечаются хвостом `MAYBE_SAVED` (`src/jira/http.ts`): таймаут, сброс соединения (кроме отказа/DNS/сертификата — тогда запрос точно не ушёл), **502/503/504 прокси** (`code: 'network'`), не-JSON 2xx; после такой ошибки карточка и «сегодня» перечитываются сразу и через 15 с, а следующая отправка в ту же задачу (10 мин) один раз останавливается предупреждением; (3) дата записи не позже сегодняшней (`validateDraft(…, today)`, `max` у `input type=date`, QuickInput); (4) обязательный список в диалоге — с пустым `— выберите —` (иначе браузер молча выбирал первое значение); (5) «сегодня» на Tempo сверяет логин без учёта регистра; (6) `client.worklogs` дочитывает постраничный ответ по `startAt` (≤10 страниц); (7) таймер «сегодня» обновляет и без фокуса окна, если сменилась дата; (8) повторный `logForm` при открытом диалоге той же задачи не затирает введённое. Тесты DST/поясов `startedWithOffset`/`localDate` через `process.env.TZ`. Осталось сознательно: у задачи без оценки Tempo получает `remainingEstimateSeconds: 0` (поле обязательное — `[скоуп]` в pending); JQL `worklogDate` считается в поясе профиля Jira (записи расширения — в 12:00, их не задевает); «сегодня» без Tempo — до 100 задач без пометки об обрезке.
- Для этапа 7: `IssuePanelManager` — 5 параметров; в `esbuild.mjs` webview-входов уже три (`issue.ts`, `tempo.ts`, `common.css`) — `list.ts` добавляется четвёртым; в `common.css` есть `.dlg/.fld/.g2/.ib/.row-btns/.tl` (можно переиспользовать); `jiraffe.refresh` дергает `onRefresh` (сводку «сегодня»).

### 7. Эпики и релизы
Разделы «Эпики» и «Релизы», вкладки эпика и релиза с прогрессом и таблицей задач.

- [x] Эпики проекта: DC — `project = X AND issuetype = Epic AND resolution = Unresolved ORDER BY created DESC` (при неудаче — по id типа эпика); Cloud — то же, с `hierarchyLevel = 1` из `issueTypes`
- [x] Задачи эпика: DC — `cf[<id>] = KEY` (из `caps.epicLinkField`), Cloud — `parent = KEY`; прогресс по `statusCategory`
- [x] Релизы: `/rest/api/2/project/{key}/versions` (выпущенные / невыпущенные, даты), задачи — `fixVersion = <id>`, счётчики — `/rest/api/2/version/{id}/relatedIssueCounts`
- [ ] `epicsTree.ts` / `releasesTree.ts`: выбор проекта (общий с «Задачами» или свой — свой, как в прототипе), строки с `done/total` в description — *код и логика проверены тестами, вид дерева — пользователь*
- [ ] `listPanel.ts` + `webview/list.ts`: вкладки эпика и релиза по `vEpic` / `vRel` из прототипа (сводка, сегментная полоса, легенда, таблица); строка таблицы открывает карточку — *разметка проверена тестами, вид и клики — пользователь*
- [ ] Подключить заглушки этапа 4: ссылки эпика и релиза в карточке открывают эти вкладки — *пользователь (F5)*
- [x] `test/epics.test.ts`: построение JQL для DC и Cloud, подсчёт прогресса

**Готово, когда:** тесты зелёные, сборка и линт проходят. Smoke печатает число эпиков и версий
GARM и NEWMFC и прогресс первого эпика. Пользователь открывает эпик GARM и релиз Pulse.

**Сессия:** sonnet, high; после этапа 6 (общие файлы панелей).

**Решения (2026-10-04, по итогам сессии 7):**
- Раскладка: `src/jira/epics.ts` (JQL эпиков/детей/релиза, `progressOf`, версии, `mapListIssue`, `loadEpics` с прогрессом пачками по 10 эпиков, `searchAll` до 1000 задач), `src/jira/{client,mappers,types}.ts` (дополнены: `searchRaw`, `projectIssueTypes`, `versions`, `version`, `versionIssueCount`, `issueHead`, `mapVersion`, `NamedRef.hierarchyLevel`), `src/panels/{list,listPanel}.ts` (`list.ts` — сборка данных без vscode, `ListPanelManager` — одна вкладка на цель), типы `ListRow/EpicPage/ReleasePage/HostToList/ListToHost` в `protocol.ts`, `src/state/sectionProject.ts` (свой проект у каждого раздела, в globalState), `src/views/{epicsTree,releasesTree}.ts` (чистые `progressLabel`, `visibleVersions` — в `format.ts`), `src/commands/sections.ts` (`pickEpicProject`, `pickReleaseProject`, `loadMoreEpics`), `webview/{list,listRender}.ts`, `test/epics.test.ts`. Вне списка «Архитектуры»: `epics.ts`, `list.ts`, `sectionProject.ts`, `sections.ts`, `listRender.ts`.
- Протокол: как у карточки — состояние в хосте, отдача по `ready`, `retainContextWhenHidden: false`. view→host: `openIssue{instanceId,key}`, `openInBrowser/refresh{instanceId,kind,id}`; хост сверяет instanceId/kind/id с вкладкой, ключ — `isIssueKey`, id версии — `isVersionId`. Адреса Jira в webview не уходят, внешних ссылок и картинок с инстанса нет; CSP без unsafe-inline (ширины — `data-w`, цвет аватара — `data-bg`, через CSSOM); на `a[href]` — `stopPropagation`. `jiraffe.openEpic/openRelease` проверяют аргументы по формату. `jiraffe.refresh` обновляет оба дерева и открытые вкладки.
- Cloud: типы эпика — `hierarchyLevel === 1` из `GET /project/{key}` (там есть team-managed типы), иначе из `/issuetype`; JQL `issuetype in (id…)`. DC: `issuetype = Epic`, на 400 (русская локаль) — повтор по id типов с именем Epic/Эпик. Прогресс эпиков — один запрос `cf[id] in (…)` / `parent in (…)` на 10 эпиков (на Cloud `total` нет); упавший запрос прогресса не роняет список (прогресса нет). Лимит 1000 задач на запрос — дальше `partial` (`3/10+` в дереве, пометка на вкладке).
- Отступления от прототипа и плана: (1) **«Ревью» убрано** из полосы и легенды — есть только `statusCategory` (готово / в работе / не начато), как в решении про фильтры; (2) в дереве релизов в строке — дата и **число задач** (`relatedIssueCounts`), а не `done/total` как в прототипе: готовых там нет без второго запроса на версию, а `unresolvedIssueCount` считает по resolution, не по категории — цифры расходились бы с вкладкой; (3) показываются все не выпущенные версии и 20 последних выпущенных, остальные — строка «скрыто»; архивные не показываются; счётчики грузятся в фоне по 4 параллельно; (4) выбор проекта — кнопка в заголовке раздела + строка-подсказка (вместо `<select>`), проект общий по всем инстансам через QuickPick; (5) вкладка эпика/релиза — по одной на цель, повторное открытие — фокус и перечитывание; (6) добавлена кнопка «Обновить» на вкладке; (7) ссылка «Открыть в Jira» для релиза — `/projects/KEY/versions/ID` на DC и Cloud (при приёмке DC-адрес `?selectedItem=…release-page` вёл на список версий, а не на версию; оба адреса в браузере не проверялись); проект версии не определился — корень инстанса.
- Smoke (только GET): таблица «эпики/релизы» — проект, число эпиков и с прогрессом, прогресс первого эпика и число строк вкладки, версии (выпущено), счётчики первых пяти и прогресс первой непустой версии. Проверки внутри: строк вкладки = total прогресса; прогресс в списке = на вкладке; счётчик релиза = число задач вкладки. Прогон 2026-10-04: GARM — 16 эпиков, 4 версии (2 выпущено), счётчики 48/121/2, вкладка релиза 48 строк, проект определён; sccloud — 16 эпиков, версий 0; Cloud — 12 эпиков (через `parent`), версий 0; tatikoma — 0 эпиков. Расхождений нет.
- Для этапа 8: разделы «Эпики» и «Релизы» при отсутствии инстансов возвращают пустой список (как «Задачи») — `viewsWelcome` должен покрыть и их id (`jiraffe.epics`, `jiraffe.releases`); кэш «задачи — до refresh» для них уже так: `jiraffe.refresh` сбрасывает состояние деревьев.
- Не проверено: F5 — вид деревьев и вкладок, клики (строка таблицы → карточка, «Открыть в Jira»), ссылки эпика/релиза из карточки, QuickPick проекта, «Загрузить ещё» (эпиков больше `jiraffe.maxResults`); поведение при >1000 задач в эпике (покрыто логикой, не живьём); адрес релиза на Cloud.
- Проверено: `npm run build && npm run lint && npm test && npm run package` — зелёные, 251 тест (227 прошлых этапов не тронуты; `test/epics.test.ts` — 24 теста: JQL DC/Cloud, прогресс, версии, загрузка со стабами fetch, разметка и экранирование); `.vsix` 10 файлов (`dist/webview/list.js`); `npm run smoke` — см. выше.
- Приёмка (2026-10-04, Opus, два прохода): исправлено — (1) выпущенные версии без даты сортировались по имени строкой по возрастанию (`1.10` < `1.9`), и при >20 выпущенных в дереве оставались самые старые: тай-брейк теперь — порядок версий из API (у выпущенных обратный); (2) `percent` округлял 199/200 до 100% — 100 только когда готово всё; (3) эпик без прочитанных задач в усечённой пачке показывал `0/0+` — теперь без прогресса; DC-поле Epic Link не вида `customfield_N` давало `0/0` и «В эпике пока нет задач» — теперь «прогресса нет» и подсказка про поле; (4) фолбэк русской локали: упавший `/issuetype` или повтор с той же 400 больше не подменяют исходную ошибку Jira; (5) «Загрузить ещё» эпиков идёт по JQL первой страницы (`loadEpics(..., knownJql)`): курсор Cloud привязан к JQL, типы и фолбэк заново не выясняются; (6) `epicNames`: пачка `key in (…)` с одним недоступным эпиком падала целиком — теперь делится пополам до одиночных ключей; (7) проект версии не в кэше — `GET /project/{id}` (`client.projectKey`); не определился — «Открыть в Jira» показывает сообщение, а не открывает корень Jira; адрес релиза на DC — `/projects/KEY/versions/ID` (был список версий проекта); (8) в webview уходил `assignee.avatarUrl` вопреки решению «адресов Jira в webview нет» — строка таблицы несёт только `{id, name}`. +10 тестов (261): сортировка версий без дат, отсечка 1000 задач и `+`, несколько пачек эпиков, отрицательные сценарии фолбэка, `knownJql`, деление пачки названий, проект версии по id. Не чинили: на DC несуществующий/недоступный проект в JQL эпиков даёт 400, а не 404, — дружелюбное «Проект не найден» не срабатывает, виден текст Jira (этап 8, устойчивость к ошибкам); `+` ставится всем эпикам усечённой пачки, хотя за лимит мог выйти один.

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

По реальному коду (после приёмки этапа 2): клиент — `createJiraClient(instance, token)` из src/jira/client.ts, токен — `await store.getToken(inst.id)` (InstanceStore в src/state/instances.ts, экземпляр создаётся в activate; передать его в деревья, `store.onDidChange(fn)` — перерисовка при add/remove/updateCaps). `client.search(jql, fields?, {startAt | nextPageToken, maxResults})` → `SearchPage`: DC — `total` и `next.startAt`; Cloud — без `total`, только `next.nextPageToken` (бейдж-счётчик на Cloud — «N+», пока есть `next`); «Загрузить ещё» передаёт `page.next` как есть. `favouriteFilters`, `projects`, `issueTypes`, `priorities` на живых Jira ещё не вызывались (только мок) — первым делом прогнать их в smoke. Ошибки — `JiraError {status, message (по-русски), url, code: 'http'|'network'|'format'}`: в узел ошибки инстанса — `message`, токена в нём нет. Команды инстансов (`addInstance`, `removeInstance`, `testConnection`, `refreshCapabilities`) — в src/commands/instances.ts; узел ошибки «Проверить подключение» вызывает `jiraffe.testConnection` (сейчас он сам спрашивает инстанс через QuickPick — добавить необязательный аргумент `instanceId`). В extension.ts заглушки EmptyTree для issues/filters заменить на реальные провайдеры; epics/releases и Tempo не трогать.

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
Точки входа: src/jira/client.ts, src/jira/mappers.ts, команда jiraffe.openIssue (заглушка из сессии 3 — зарегистрирована в src/commands/filters.ts, аргумент `IssueRef {instanceId, key}` из src/views/issuesTree.ts; заменить тело на открытие карточки, остальной файл не трогать; `InstanceMeta.client(inst)` из src/state/meta.ts — готовая фабрика клиента по инстансу), esbuild.mjs (webview-бандл).
Эпик в IssueDetail — строго по «Контракту эпика» в решениях этапа 2: DC — `instance.epicLinkField ?? caps.epicLinkField`, Cloud — `fields.parent` с `issuetype.hierarchyLevel === 1` (запросить `parent` в fields).

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
Точки входа: src/jira/http.ts (auth), src/panels/issuePanel.ts (+ src/panels/card.ts — `loadCard`), src/panels/protocol.ts (`ISSUE_TABS` — добавить вкладку `att`), webview/issue.ts + webview/render.ts (`renderTabs`/`renderCard`; inline-стили запрещены CSP — динамические цвета/ширины через `data-*` и `paint()` в issue.ts), src/jira/sanitize.ts: картинки описания там уже заменены на `<span class="img-ph" data-src="абсолютный URL">` — хост находит `.img-ph[data-src]` и подменяет на `data:`-`<img>` (санитайзер после подмены не гонять повторно по `data:`-схеме без явного разрешения).
По реальному коду (приёмка 4): `data-src` получают только картинки своего инстанса (origin + context path `baseUrl`), чужие http(s)-картинки уже стали ссылкой «[внешняя картинка]» — но хост при скачивании всё равно **сам** проверяет, что адрес same-origin и под context path, и только тогда шлёт `Authorization` (атрибуту не доверять; токен наружу не уходит никогда). Ссылки в webview: клик перехватывает `webview/issue.ts` (`preventDefault` + `stopPropagation`, иначе VS Code откроет повторно) и шлёт `openExternal`; новые действия view→host над задачей — с `key`, хост сверяет с `entry.ref.key` (`CARD_ACTIONS` в `issuePanel.ts`). Вложения на вкладке `att` — их `contentUrl` тоже проверять на same-origin перед авторизованным GET. `IssueDetail.attachments` уже заполнен маппером (`contentUrl`, `thumbnailUrl`). Новый метод HttpClient — рядом с `getJson`, с проверкой смены origin и `scrub` (решения этапа 2).

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
Точки входа: src/jira/client.ts, src/jira/capabilities.ts, src/duration.ts, src/commands/issue.ts (заглушка команды `jiraffe.logWork(IssueRef)` — заменить тело; карточка вызывает её командой), webview/render.ts (`renderWorklog` — таблица журнала, читает `client.worklogs`), views jiraffe.tempo (заглушка из сессии 1).
По реальному коду (после этапа 5): `loadCard` (src/panels/card.ts) возвращает `{card, files, inlineUrls}` — журнал из Tempo добавлять в `card.worklogs`, `files`/`inlineUrls` не трогать; `IssuePanelManager` принимает 4-м параметром `AttachmentService`; вкладок 5 (`ISSUE_TABS` с `att`). Новый POST — метод HttpClient рядом с `getJson`/`getBinary`, с проверкой origin и `scrub` (модель редиректов — как в `getBinary`: `Authorization` только адресам инстанса и пока цепочка его не покидала; для POST редирект лучше вообще считать ошибкой). Недоверенный текст (summary, имена, ответы Jira) в `show*Message`/`withProgress` — только через `noticeText` из `src/jira/attachments.ts`: в уведомлениях VS Code работают markdown-ссылки, в т.ч. `command:`.

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
Точки входа: src/jira/client.ts, src/jira/capabilities.ts (epicLinkField), src/panels/html.ts (`renderShell` — общий каркас, подходит и для list.js; CSP тот же, картинок с инстанса в списках не грузить — иконки свои SVG, как в карточке) и protocol.ts (там типы карточки; для списков завести свои типы рядом), заглушки в src/commands/issue.ts: `jiraffe.openEpic({instanceId, key})` и `jiraffe.openRelease({instanceId, id})` — заменить тело, карточка уже вызывает их командами; `webview/list.ts` добавить ещё одним входом в `esbuild.mjs` (webview-бандл; там уже `issue.ts`, `tempo.ts` и `common.css` — этап 6), стили — в `webview/common.css` (там уже есть `.pill`, `.bar`, `table.t`, `.crumbs`, `.hrow`; цвета только `--vscode-*`), `renderEpics`-аналоги писать чистыми функциями как `webview/render.ts`.
По реальному коду (после этапа 6): `IssuePanelManager` принимает 5 параметров (5-й — `WorklogService`), протокол карточки дополнен `logForm`/`logResult`/`submitWorklog` — не ломать; `jiraffe.refresh` уже обновляет сводку «сегодня» (`onRefresh` в `registerFilterCommands`). Эпики — по «Контракту эпика» в решениях этапа 2 (DC — поле Epic Link и `cf[<id>] = KEY`, Cloud — `parent = KEY`, эпик = `hierarchyLevel === 1`); на Cloud `caps.epicLinkField` всегда `null` — это норма, не ошибка.

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
Точки входа: package.json (contributes.viewsWelcome, version), src/views/*.ts, src/jira/client.ts. После этапа 6: расширение активируется `onStartupFinished` (строка состояния «Сегодня» с первых секунд) — если пользователь отклонил это в `roadmap-mvp.pending.md`, вернуть `activationEvents: []`; у раздела Tempo своё пустое состояние (`webview/today.ts`). После этапа 7: `viewsWelcome` нужен и для `jiraffe.epics`/`jiraffe.releases` (без инстансов они пустые; с инстансами, но без выбранного проекта, показывают строку-подсказку «Выберите проект»). Ошибки разделов эпиков: на DC несуществующий/недоступный проект в JQL — 400 (не 404), текст «Проект … не найден или нет доступа» сейчас только для 404 — привести к общей обработке ошибок инстанса. Кнопка «Обновить» в заголовке «Эпиков»/«Релизов» — общий `jiraffe.refresh` (перечитывает всё и `meta.invalidate()`) — если вводится кэш, решить, нужен ли раздельный refresh.

Уже решено: кэш только в памяти; README отмечает чекбоксы функций по факту, не авансом.

Порядок: чекбоксы этапа 8 сверху вниз.

DoD: npm run build && npm run lint && npm test && npm run smoke && npm run package зелёные; jiraffe-0.1.0.vsix собран.

Не делать: функции из «Позже» README. Остальное — общие строки roadmap.
Последним сообщением — отчёт + полный чеклист приёмки MVP для пользователя.
```

## Риски и открытые вопросы

- **Tempo v3 — чтение ворклогов.** ~~Endpoint и параметры не проверены.~~ Проверено на этапе 6
  (см. «Допущения»): работает, но без фильтра по задаче — атрибуты журнала карточки берутся
  по одному GET на ворклог (до 50).
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
- **Ворклоги Tempo в стандартном `/worklog`.** ~~Если на Pilot их там нет…~~ Есть (этап 6) —
  журнал задачи на Pilot стандартный + атрибуты Tempo.
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
