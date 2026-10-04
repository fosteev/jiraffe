// Санитизация HTML из renderedFields. Чистый модуль (без vscode) — бандлится в extension.js вместе с sanitize-html.
import sanitizeHtml from 'sanitize-html';
import type { IssueDetail } from './types';

/** Теги из рендера Jira (p, h1–h6, списки, pre/code, таблицы, ссылки…); остальные вычищаются, текст остаётся. */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'strong', 'em', 'b', 'i', 'u', 's',
  'del', 'ins', 'sub', 'sup', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'span', 'div', 'blockquote',
];

/**
 * Абсолютный URL для ссылок и картинок. Jira отдаёт относительные (`/browse/…`); путь с ведущим `/` уже содержит
 * context path инстанса (`/jira/browse/…`), поэтому его резолвим от origin; путь без `/` — от baseUrl.
 * Якоря `#…` вне страницы Jira смысла не имеют (вели бы в корень) — отбрасываются.
 */
function resolveHref(url: string, baseUrl: string): string {
  const t = url.trim();
  if (!t || t.startsWith('#')) return '';
  try {
    const base = new URL(baseUrl);
    return new URL(t, t.startsWith('/') ? base.origin + '/' : base.href.replace(/\/*$/, '/')).toString();
  } catch {
    return '';
  }
}

/**
 * Картинка своего инстанса (тот же origin и context path) — адрес, который хост скачает С АВТОРИЗАЦИЕЙ.
 * Всё остальное (чужой хост, `data:`, `javascript:`, `file:`) сюда не попадает: токен не должен уйти наружу.
 */
function ownImageSrc(abs: string, baseUrl: string): string {
  try {
    const u = new URL(abs);
    const base = new URL(baseUrl);
    const root = base.pathname.replace(/\/*$/, '/');
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === base.origin && u.pathname.startsWith(root) ? u.toString() : '';
  } catch {
    return '';
  }
}

export function sanitizeJiraHtml(html: string, baseUrl: string): string {
  if (!html) return '';
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'title'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], span: ['class', 'data-src', 'title'] },
    // Классы Jira не нужны и могут пересечься с нашими стилями: оставляем только свой плейсхолдер картинки.
    allowedClasses: { span: ['img-ph'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      tt: 'code',
      // Входящие span из Jira: `class="img-ph"`/`data-src` может выставить только наш img-трансформ ниже — иначе
      // автор описания подсунул бы этапу 5 произвольный адрес для авторизованного скачивания.
      span: (_tag, attribs) => ({ tagName: 'span', attribs: attribs.title ? { title: attribs.title } : ({} as Record<string, string>) }),
      a: (tag, attribs) => {
        const href = attribs.href ? resolveHref(attribs.href, baseUrl) : '';
        return { tagName: 'a', attribs: href ? { href, ...(attribs.title ? { title: attribs.title } : {}) } : {} };
      },
      // Картинки: своя — плейсхолдер с data-src (хост заменит адрес на номер — `extractInlineImages` — и скачает с
      // авторизацией), чужая http(s) — ссылкой (CSP не пускает чужие хосты, а авторизованно качать с них нельзя),
      // прочие схемы — плейсхолдер без адреса.
      img: (_tag, attribs) => {
        const abs = attribs.src ? resolveHref(attribs.src, baseUrl) : '';
        const own = abs ? ownImageSrc(abs, baseUrl) : '';
        const title: Record<string, string> = attribs.alt ? { title: attribs.alt } : {};
        if (!own && /^https?:\/\//i.test(abs)) return { tagName: 'a', attribs: { href: abs, ...title }, text: '[внешняя картинка]' };
        return { tagName: 'span', attribs: { class: 'img-ph', ...(own ? { 'data-src': own } : {}), ...title }, text: '[картинка]' };
      },
    },
    // Пустые якоря (`<a name="…"></a>` в заголовках) — мусор.
    exclusiveFilter: (f) => f.tag === 'a' && !f.attribs.href && !f.text.trim(),
  });
}

/** Санитизирует все HTML-поля задачи. Исходный объект не мутируется. */
export function sanitizeDetail(d: IssueDetail, baseUrl: string): IssueDetail {
  return {
    ...d,
    descriptionHtml: sanitizeJiraHtml(d.descriptionHtml, baseUrl),
    comments: d.comments.map((c) => ({ ...c, bodyHtml: sanitizeJiraHtml(c.bodyHtml, baseUrl) })),
  };
}
