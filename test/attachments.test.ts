import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachmentFileNames, attachmentPath, attachmentUrls, extractInlineImages, imageRejection, imageSize, isImageAttachment, isTextAttachment, limiter,
  looksLikeText, LruCache, MAX_SVG_BYTES, noticeText, resolveAttachmentsRoot, safeFileName, sniffImage, toDataUri,
} from '../src/jira/attachments';
import { HttpClient, JiraError, isOwnUrl } from '../src/jira/http';
import { sanitizeJiraHtml } from '../src/jira/sanitize';
import type { Attachment, IssueDetail } from '../src/jira/types';
import { attachmentView } from '../src/panels/card';
import { isAttachmentId, isImageId } from '../src/panels/protocol';
import { fmtSize, renderAttachments, renderLightbox } from '../webview/render';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
type Call = { url: string; init: RequestInit };
const authOf = (c: Call): string | undefined => (c.init.headers as Record<string, string>).Authorization;

/** Мок fetch по таблице «адрес → ответ». */
function routes(map: Record<string, () => Response>, calls: Call[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = map[url];
    if (!r) throw new Error('unexpected ' + url);
    return r();
  }) as unknown as typeof fetch;
}
const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const ok = (body: Uint8Array, headers: Record<string, string> = {}) => () => new Response(body as unknown as BodyInit, { status: 200, headers });
const fail = (p: Promise<unknown>): Promise<JiraError> => p.then(() => { throw new Error('ожидалась ошибка'); }, (e: unknown) => e as JiraError);

const BASE = 'https://jira.example.test/jira';
const http = (map: Record<string, () => Response>, calls: Call[], kind: 'dc' | 'cloud' = 'dc', baseUrl = BASE) =>
  new HttpClient({ baseUrl, kind, token: 'sekret-token', email: 'ivan@example.test', fetchImpl: routes(map, calls) });

describe('isOwnUrl', () => {
  it('тот же origin и context path', () => {
    expect(isOwnUrl(`${BASE}/secure/attachment/1/a.png`, BASE)).toBe(true);
    expect(isOwnUrl('https://jira.example.test/secure/attachment/1/a.png', BASE)).toBe(false); // вне /jira
    expect(isOwnUrl('https://jira.example.test/jiraX/a.png', BASE)).toBe(false);
    expect(isOwnUrl('http://jira.example.test/jira/a.png', BASE)).toBe(false); // другая схема — другой origin
    expect(isOwnUrl('https://evil.test/jira/a.png', BASE)).toBe(false);
    expect(isOwnUrl('https://jira.example.test.evil.test/jira/a.png', BASE)).toBe(false);
    expect(isOwnUrl('https://u:p@jira.example.test/jira/a.png', BASE)).toBe(false);
    expect(isOwnUrl('javascript:alert(1)', BASE)).toBe(false);
    expect(isOwnUrl('https://ex.atlassian.net/rest/api/2/attachment/content/1', 'https://ex.atlassian.net')).toBe(true);
  });
});

describe('HttpClient.getBinary', () => {
  it('свой адрес — с авторизацией, байты и Content-Type', async () => {
    const calls: Call[] = [];
    const r = await http({ [`${BASE}/secure/attachment/1/a.png`]: ok(PNG, { 'content-type': 'text/html' }) }, calls).getBinary(`${BASE}/secure/attachment/1/a.png`, { maxBytes: 100 });
    expect(Array.from(r.bytes)).toEqual(Array.from(PNG));
    expect(r.mime).toBe('text/html'); // как есть — ему не доверяем
    expect(authOf(calls[0])).toBe('Bearer sekret-token');
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('чужой адрес — blocked, запроса нет', async () => {
    const calls: Call[] = [];
    const e = await fail(http({}, calls).getBinary('https://evil.test/x.png', { maxBytes: 100 }));
    expect(e.code).toBe('blocked');
    expect(calls).toHaveLength(0);
    const e2 = await fail(http({}, calls).getBinary('https://jira.example.test/secure/x.png', { maxBytes: 100 })); // вне context path
    expect(e2.code).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('Cloud: редирект на media-хост — по https и БЕЗ Authorization', async () => {
    const calls: Call[] = [];
    const base = 'https://ex.atlassian.net';
    const media = 'https://api.media.atlassian.com/file/abc/binary?token=SIGNED&client=1';
    const r = await http({ [`${base}/rest/api/2/attachment/content/10001`]: redirect(media, 303), [media]: ok(PNG) }, calls, 'cloud', base)
      .getBinary(`${base}/rest/api/2/attachment/content/10001`, { maxBytes: 100 });
    expect(r.bytes.length).toBe(PNG.length);
    expect(authOf(calls[0])).toMatch(/^Basic /);
    expect(authOf(calls[1])).toBeUndefined();
  });

  it('редирект на тот же инстанс — снова с авторизацией; на http-чужой — отказ', async () => {
    const calls: Call[] = [];
    await http({ [`${BASE}/a`]: redirect('/jira/b'), [`${BASE}/b`]: ok(PNG) }, calls).getBinary(`${BASE}/a`, { maxBytes: 100 });
    expect(authOf(calls[1])).toBe('Bearer sekret-token');
    const calls2: Call[] = [];
    const e = await fail(http({ [`${BASE}/a`]: redirect('http://cdn.example.test/x') }, calls2).getBinary(`${BASE}/a`, { maxBytes: 100 }));
    expect(e.code).toBe('redirect');
    expect(calls2).toHaveLength(1);
  });

  it('цепочка, покинувшая инстанс, Authorization больше не получает — даже вернувшись на свой адрес; без Location — ошибка', async () => {
    const calls: Call[] = [];
    await http({ [`${BASE}/a`]: redirect('https://media.example.test/x'), 'https://media.example.test/x': redirect(`${BASE}/b`), [`${BASE}/b`]: ok(PNG) }, calls)
      .getBinary(`${BASE}/a`, { maxBytes: 100 });
    expect(calls.map(authOf)).toEqual(['Bearer sekret-token', undefined, undefined]);
    const calls2: Call[] = [];
    await http({ [`${BASE}/a`]: redirect('/other/x'), 'https://jira.example.test/other/x': ok(PNG) }, calls2).getBinary(`${BASE}/a`, { maxBytes: 100 });
    expect(authOf(calls2[1])).toBeUndefined(); // тот же origin, но вне context path — без токена
    const e = await fail(http({ [`${BASE}/a`]: () => new Response(null, { status: 302 }) }, []).getBinary(`${BASE}/a`, { maxBytes: 100 }));
    expect(e.code).toBe('redirect');
    // Инстанс по http, сервер уводит на https того же хоста — понятная ошибка, а не 401 без токена.
    const calls3: Call[] = [];
    const e3 = await fail(http({ 'http://jira.example.test/a': redirect('https://jira.example.test/a') }, calls3, 'dc', 'http://jira.example.test').getBinary('http://jira.example.test/a', { maxBytes: 100 }));
    expect(e3.code).toBe('redirect');
    expect(e3.message).toContain('https://jira.example.test');
    expect(calls3).toHaveLength(1);
    // https-инстанс → http того же хоста (даунгрейд) — отказ без запроса.
    const calls4: Call[] = [];
    const e4 = await fail(http({ [`${BASE}/a`]: redirect('http://jira.example.test/jira/a') }, calls4).getBinary(`${BASE}/a`, { maxBytes: 100 }));
    expect(e4.code).toBe('redirect');
    expect(calls4).toHaveLength(1);
  });

  it('редирект на login.jsp — 401, не HTML вместо файла; цикл редиректов — ошибка', async () => {
    const e = await fail(http({ [`${BASE}/a`]: redirect(`${BASE}/login.jsp?os_destination=x`) }, []).getBinary(`${BASE}/a`, { maxBytes: 100 }));
    expect(e.status).toBe(401);
    const e2 = await fail(http({ [`${BASE}/a`]: redirect(`${BASE}/a`) }, []).getBinary(`${BASE}/a`, { maxBytes: 100 }));
    expect(e2.code).toBe('redirect');
  });

  it('лимит: по Content-Length до чтения и по потоку', async () => {
    const e = await fail(http({ [`${BASE}/a`]: ok(new Uint8Array(50), { 'content-length': '5000000' }) }, []).getBinary(`${BASE}/a`, { maxBytes: 1000 }));
    expect(e.code).toBe('limit');
    const stream = () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(400)); } }), { status: 200 });
    const e2 = await fail(http({ [`${BASE}/a`]: stream }, []).getBinary(`${BASE}/a`, { maxBytes: 1000 }));
    expect(e2.code).toBe('limit');
    expect(e2.message).toContain('limit');
  });

  it('ошибка HTTP — без токена в сообщении', async () => {
    const body = () => new Response(JSON.stringify({ errorMessages: ['bad sekret-token'] }), { status: 403 });
    const e = await fail(http({ [`${BASE}/a`]: body }, []).getBinary(`${BASE}/a`, { maxBytes: 100 }));
    expect(e.status).toBe(403);
    expect(e.message).not.toContain('sekret-token');
  });
});

const detail = (descriptionHtml: string, comments: string[] = []): IssueDetail => ({
  instanceId: 'i', key: 'ABC-1', summary: 's', type: 'Task', status: 'Open', statusCategory: 'new', updated: '', watchers: [], descriptionHtml,
  fixVersions: [], labels: [], components: [], created: '', timetracking: {}, attachments: [], history: [],
  comments: comments.map((bodyHtml, n) => ({ id: String(n), created: '', bodyHtml })),
});

describe('картинки описания: img src → data-img', () => {
  it('свои (относительные, абсолютные, context path) получают номер; чужие — ссылка; повтор — тот же номер', () => {
    const raw = [
      '<img src="/jira/secure/attachment/10/a.png?x=1&amp;y=2" alt="A">',
      `<img src="${BASE}/secure/thumbnail/11/_thumb_11.png">`,
      '<img src="https://evil.test/track.png">',
      '<img src="/secure/attachment/12/outside.png">', // тот же хост, но вне context path /jira
      '<img src="data:image/png;base64,AAAA">',
    ].join('');
    const html = sanitizeJiraHtml(raw, BASE);
    const comment = sanitizeJiraHtml('<img src="/jira/secure/attachment/10/a.png?x=1&y=2">', BASE);
    const { issue, urls } = extractInlineImages(detail(html, [comment]), BASE);
    expect(urls).toEqual([`${BASE}/secure/attachment/10/a.png?x=1&y=2`, `${BASE}/secure/thumbnail/11/_thumb_11.png`]);
    expect(issue.descriptionHtml).toContain('data-img="i0" title="A"');
    expect(issue.descriptionHtml).toContain('data-img="i1"');
    expect(issue.descriptionHtml).not.toContain('data-src');
    expect(issue.descriptionHtml).toContain('<a href="https://evil.test/track.png">[external image]</a>');
    expect(issue.descriptionHtml).not.toMatch(/evil\.test\/track\.png"[^>]*data-img/);
    expect(issue.comments[0].bodyHtml).toContain('data-img="i0"');
    expect((issue.descriptionHtml.match(/data-img=/g) ?? []).length).toBe(2);
  });

  it('подделанный плейсхолдер из HTML Jira номера не получает', () => {
    const html = sanitizeJiraHtml(`<span class="img-ph" data-src="${BASE}/rest/api/2/myself">x</span>`, BASE);
    const { urls, issue } = extractInlineImages(detail(html), BASE);
    expect(urls).toEqual([]);
    expect(issue.descriptionHtml).not.toContain('data-img');
  });

  it('data-src, ставший чужим (вписан руками в уже санитизированный HTML), не качается', () => {
    const { urls, issue } = extractInlineImages(detail('<span class="img-ph" data-src="https://evil.test/jira/x.png">[image]</span>'), BASE);
    expect(urls).toEqual([]);
    expect(issue.descriptionHtml).toBe('<span class="img-ph">[image]</span>');
  });
});

const att = (o: Partial<Attachment>): Attachment => ({ id: '1', filename: 'a.png', size: 10, mimeType: 'image/png', created: '2026-01-01', contentUrl: '', ...o });

describe('вложения: адреса, тип, имя файла', () => {
  it('attachmentUrls: свой адрес как есть, чужой — пересобран из baseUrl и id', () => {
    const own = att({ contentUrl: `${BASE}/secure/attachment/1/a.png`, thumbnailUrl: `${BASE}/secure/thumbnail/1/_thumb_1.png` });
    expect(attachmentUrls(own, { baseUrl: BASE, kind: 'dc' })).toEqual({ content: own.contentUrl, thumbnail: own.thumbnailUrl });
    const foreign = att({ id: '7', filename: 'a b.png', contentUrl: 'http://old-host.test/secure/attachment/7/a b.png', thumbnailUrl: 'http://old-host.test/t' });
    expect(attachmentUrls(foreign, { baseUrl: BASE, kind: 'dc' })).toEqual({ content: `${BASE}/secure/attachment/7/a%20b.png`, thumbnail: `${BASE}/secure/thumbnail/7/_thumb_7.png` });
    expect(attachmentUrls(att({ id: '7', contentUrl: 'https://evil.test/x', thumbnailUrl: 'https://evil.test/t' }), { baseUrl: 'https://ex.atlassian.net', kind: 'cloud' }))
      .toEqual({ content: 'https://ex.atlassian.net/rest/api/2/attachment/content/7', thumbnail: 'https://ex.atlassian.net/rest/api/2/attachment/thumbnail/7' });
    expect(attachmentUrls(att({ id: '../x', contentUrl: 'https://evil.test/x' }), { baseUrl: BASE, kind: 'dc' })).toEqual({});
  });

  it('safeFileName: каталоги, .., управляющие символы, Windows', () => {
    expect(safeFileName('../../etc/passwd', 'f')).toBe('passwd');
    expect(safeFileName('..\\..\\Windows\\win.ini', 'f')).toBe('win.ini');
    expect(safeFileName('..', 'f')).toBe('f');
    expect(safeFileName('a／b＼c.png', 'f')).toBe('a_b_c.png');
    expect(safeFileName('﻿x y.txt', 'f')).toBe('xy.txt');
    expect(safeFileName('.', 'f')).toBe('f');
    expect(safeFileName('', 'f')).toBe('f');
    expect(safeFileName('/', 'f')).toBe('f');
    expect(safeFileName('.bashrc', 'f')).toBe('bashrc');
    expect(safeFileName('a\u0000b\nc‮.png', 'f')).toBe('abc.png');
    expect(safeFileName('a<b>:c"|?*.txt', 'f')).toBe('a_b__c____.txt');
    expect(safeFileName('report. ', 'f')).toBe('report');
    expect(safeFileName('CON.txt', 'f')).toBe('_CON.txt');
    expect(safeFileName('Скриншот 1.png', 'f')).toBe('Скриншот 1.png');
    const long = safeFileName('я'.repeat(300) + '.log', 'f');
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(180);
    expect(long.endsWith('.log')).toBe(true);
  });

  it('attachmentFileNames: дубликаты имён получают id, имя стабильно', () => {
    const list = [att({ id: '2', filename: 'image.png', created: '2026-01-02' }), att({ id: '1', filename: 'image.png', created: '2026-01-01' }), att({ id: '3', filename: '../IMAGE.png', created: '2026-01-03' })];
    const n = attachmentFileNames(list);
    expect(n.get('1')).toBe('image.png');
    expect(n.get('2')).toBe('image (2).png');
    expect(n.get('3')).toBe('IMAGE (3).png');
    expect(attachmentFileNames([...list].reverse()).get('2')).toBe('image (2).png');
    // Длинные тёзки: суффикс не отрезается обрезкой до 180 байт — два вложения не пишутся в один файл.
    const long = attachmentFileNames([att({ id: '1', filename: `${'я'.repeat(200)}.png`, created: '1' }), att({ id: '2', filename: `${'я'.repeat(200)}.png`, created: '2' })]);
    expect(long.get('1')).not.toBe(long.get('2'));
    expect(long.get('2')).toMatch(/ \(2\)\.png$/);
    expect(Buffer.byteLength(long.get('2') ?? '')).toBeLessThanOrEqual(180);
  });

  it('attachmentPath: остаётся внутри <root>/<KEY>', () => {
    const root = path.resolve('/tmp/x/.jiraffe');
    expect(attachmentPath(root, 'ABC-1', 'a.png')).toBe(path.join(root, 'ABC-1', 'a.png'));
    expect(attachmentPath(root, 'ABC-1', '../b.png')).toBeUndefined();
    expect(attachmentPath(root, 'ABC-1', 'sub/b.png')).toBeUndefined();
    expect(attachmentPath(root, '../../etc', 'a')).toBe(path.join(root, 'etc', 'a'));
  });

  it('resolveAttachmentsRoot: workspace, tmp, абсолютный только из пользовательских настроек', () => {
    const ws = path.resolve('/w/proj');
    const tmp = path.resolve('/tmp');
    expect(resolveAttachmentsRoot({ setting: '.jiraffe', fromWorkspace: false, workspaceDir: ws, tmpDir: tmp })).toEqual({ root: path.join(ws, '.jiraffe'), inWorkspace: true, isDefault: true, tmp: false });
    expect(resolveAttachmentsRoot({ setting: undefined, fromWorkspace: false, tmpDir: tmp })).toMatchObject({ root: path.join(tmp, 'jiraffe'), tmp: true });
    expect(resolveAttachmentsRoot({ setting: 'docs/att', fromWorkspace: true, workspaceDir: ws, tmpDir: tmp })).toMatchObject({ root: path.join(ws, 'docs', 'att'), isDefault: false });
    const esc = resolveAttachmentsRoot({ setting: '../../.ssh', fromWorkspace: true, workspaceDir: ws, tmpDir: tmp });
    expect(esc.root).toBe(path.join(ws, '.jiraffe'));
    expect(esc.warning).toBeTruthy();
    const absWs = resolveAttachmentsRoot({ setting: path.resolve('/home/u/.ssh'), fromWorkspace: true, workspaceDir: ws, tmpDir: tmp });
    expect(absWs.root).toBe(path.join(ws, '.jiraffe'));
    expect(absWs.warning).toBeTruthy();
    expect(resolveAttachmentsRoot({ setting: path.resolve('/data/jira'), fromWorkspace: false, tmpDir: tmp })).toMatchObject({ root: path.resolve('/data/jira'), tmp: false });
  });

  it('тип: картинка по сигнатуре, а не по Content-Type; текст — по имени/метаданным и без NUL', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffImage(new TextEncoder().encode('<!DOCTYPE html><html><body>login</body></html>'))).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode('<html><svg></svg></html>'))).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode('\ufeff<!-- a --><!-- b -->\n<!DOCTYPE svg PUBLIC "x"><svg>'))).toBe('image/svg+xml');
    // ReDoS: сотни пустых комментариев без <svg> — линейно, а не экспоненциально.
    const t0 = Date.now();
    expect(sniffImage(new TextEncoder().encode(`${'<!---->'.repeat(600)}x`))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(200);
    expect(toDataUri('image/png', PNG)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    expect(isImageAttachment({ filename: 'x.PNG', mimeType: 'application/octet-stream' })).toBe(true);
    expect(isImageAttachment({ filename: 'x.pdf', mimeType: 'application/pdf' })).toBe(false);
    expect(isTextAttachment({ filename: 'server.log', mimeType: 'application/octet-stream' })).toBe(true);
    expect(isTextAttachment({ filename: 'data', mimeType: 'application/json' })).toBe(true);
    expect(isTextAttachment({ filename: 'run.exe', mimeType: 'application/x-msdownload' })).toBe(false);
    expect(isTextAttachment({ filename: 'page.html', mimeType: 'application/octet-stream' })).toBe(false);
    expect(looksLikeText(new TextEncoder().encode('строка\nлог'))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x41, 0, 0x42]))).toBe(false);
  });
});

describe('размер картинки и текст уведомлений', () => {
  const png = (w: number, h: number): Uint8Array => {
    const b = new Uint8Array(24);
    b.set(PNG.subarray(0, 8));
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  it('imageSize/imageRejection: пиксельная бомба и большой SVG отвергаются', () => {
    expect(imageSize(png(800, 600), 'image/png')).toEqual({ w: 800, h: 600 });
    expect(imageRejection(png(800, 600), 'image/png')).toBeUndefined();
    expect(imageRejection(png(30000, 30000), 'image/png')).toMatch(/30000×30000/);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00]);
    expect(imageSize(gif, 'image/gif')).toEqual({ w: 16, h: 32 });
    // JPEG: APP0 (длина 16), затем SOF0 с h=0x0100, w=0x0200.
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03]);
    expect(imageSize(jpg, 'image/jpeg')).toEqual({ w: 512, h: 256 });
    expect(imageRejection(new Uint8Array(MAX_SVG_BYTES + 1), 'image/svg+xml')).toBeTruthy();
  });
  it('noticeText: markdown-ссылки из имени вложения не становятся ссылками в уведомлении', () => {
    const t = noticeText('x [Открыть](command:workbench.action.terminal.sendSequence?%7B%7D).txt');
    expect(t).not.toMatch(/[[\]]/);
    expect(noticeText('a'.repeat(500), 10)).toBe(`${'a'.repeat(10)}…`);
  });
});

describe('протокол и разметка вложений', () => {
  it('id картинок и вложений — строго по формату', () => {
    for (const ok of ['i0', 'i12', 't10001', 'f10001']) expect(isImageId(ok)).toBe(true);
    for (const bad of ['', 'x1', 'i', 't-1', 'f1/../2', 'i1 ', 'https://x', 'i123456']) expect(isImageId(bad)).toBe(false);
    expect(isAttachmentId('10001')).toBe(true);
    expect(isAttachmentId('../1')).toBe(false);
    expect(isAttachmentId(1)).toBe(false);
  });

  it('attachmentView убирает адреса Jira', () => {
    const v = attachmentView(att({ contentUrl: `${BASE}/secure/attachment/1/a.png`, thumbnailUrl: `${BASE}/t` }));
    expect(JSON.stringify(v)).not.toContain('jira.example.test');
    expect(v).toMatchObject({ image: true, text: false });
  });

  it('вкладка «Вложения» и лайтбокс экранируют имя, превью — плейсхолдер data-img', () => {
    const c = { attachments: [
      { ...attachmentView(att({ id: '5', filename: '<img src=x onerror=alert(1)>.png', author: { id: 'ivan', name: 'Ivan "P"' } })) },
      { ...attachmentView(att({ id: '6', filename: 'app.log', mimeType: 'text/plain' })) },
    ] } as Parameters<typeof renderAttachments>[0];
    const html = renderAttachments(c);
    expect(html).not.toContain('<img');
    expect(html).toContain('data-img="t5"');
    expect(html).toContain('data-act="openAtt" data-id="6"');
    expect(html).not.toContain('data-act="openAtt" data-id="5"');
    expect(html).toContain('data-act="dlAll"');
    expect(renderAttachments({ attachments: [] } as unknown as Parameters<typeof renderAttachments>[0])).toContain('No attachments');
    const lb = renderLightbox('f5', '<b>x</b>', c.attachments[0]);
    expect(lb).toContain('data-img="f5"');
    expect(lb).not.toContain('<b>x');
    expect(lb).not.toMatch(/ style=/);
    expect(fmtSize(512)).toBe('512 B');
    expect(fmtSize(1536 * 1024)).toBe('1.5 MB');
  });
});

describe('LruCache и limiter', () => {
  it('LRU выселяет самое старое по весу', () => {
    const c = new LruCache<string>(10);
    c.set('a', 'A', 4);
    c.set('b', 'B', 4);
    c.get('a');
    c.set('c', 'C', 4);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe('A');
    c.set('huge', 'H', 11);
    expect(c.get('huge')).toBeUndefined();
    expect(c.weight).toBeLessThanOrEqual(10);
  });

  it('limiter: отказ задачи освобождает слот, очередь не теряется', async () => {
    const run = limiter(1);
    const r = await Promise.allSettled([run(() => Promise.reject(new Error('x'))), run(() => { throw new Error('sync'); }), run(async () => 3)]);
    expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
  });

  it('limiter держит не больше n задач', async () => {
    const run = limiter(2);
    let active = 0;
    let peak = 0;
    const job = () => run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
  });
});
