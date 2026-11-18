// Markdown for Agents: content negotiation for Cloudflare Pages.
//
// Requests that prefer `Accept: text/markdown` get a Markdown rendering of the
// HTML page; everything else (browsers) gets the normal HTML. Both variants are
// served with `Vary: Accept` so caches keep them apart.
//
// Try it: curl -H 'Accept: text/markdown' https://adventmaker.app/

// Keep in sync with the Content-Signal line in robots.txt.
const CONTENT_SIGNAL = 'search=yes, ai-input=yes, ai-train=yes';

export async function onRequest({ request, next }) {
  const wantsMarkdown =
    (request.method === 'GET' || request.method === 'HEAD') &&
    prefersMarkdown(request.headers.get('Accept'));

  if (!wantsMarkdown) {
    const res = await next();
    if (!isHtml(res)) return res;
    const out = new Response(res.body, res);
    appendVary(out.headers);
    return out;
  }

  // Drop conditional headers: the HTML's ETag/Last-Modified don't describe
  // the Markdown variant, so a 304 for the HTML would be wrong here.
  const headers = new Headers(request.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  const res = await next(new Request(request, { headers }));
  if (!isHtml(res)) return res;

  const markdown = htmlToMarkdown(await res.text(), request.url);
  const out = new Response(request.method === 'HEAD' ? null : markdown, res);
  out.headers.set('Content-Type', 'text/markdown; charset=utf-8');
  out.headers.set('X-Markdown-Tokens', String(Math.ceil(markdown.length / 4)));
  out.headers.set('Content-Signal', CONTENT_SIGNAL);
  for (const h of ['Content-Length', 'ETag', 'Last-Modified', 'Link']) out.headers.delete(h);
  appendVary(out.headers);
  return out;
}

function isHtml(res) {
  return (res.headers.get('Content-Type') || '').toLowerCase().includes('text/html');
}

function appendVary(headers) {
  const vary = headers.get('Vary');
  if (!vary) headers.set('Vary', 'Accept');
  else if (!/(^|,)\s*accept\s*(,|$)/i.test(vary)) headers.set('Vary', `${vary}, Accept`);
}

// True when the Accept header lists text/markdown with q > 0 and at least the
// q-value of text/html. Browsers never mention text/markdown, so they get HTML.
export function prefersMarkdown(accept) {
  if (!accept) return false;
  let md = 0;
  let html = 0;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q') q = Number.parseFloat(v) || 0;
    }
    if (type.trim() === 'text/markdown') md = Math.max(md, q);
    else if (type.trim() === 'text/html') html = Math.max(html, q);
  }
  return md > 0 && md >= html;
}

// ---------------------------------------------------------------------------
// Minimal HTML → Markdown converter, tailored to this site's hand-written HTML.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const SKIP = new Set(['head', 'script', 'style', 'noscript', 'svg', 'nav', 'template', 'iframe', 'button', 'form']);
const INLINE = new Set(['a', 'abbr', 'b', 'br', 'cite', 'code', 'em', 'i', 'img', 'kbd', 'mark', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'wbr']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', middot: '·', rarr: '→', larr: '←', times: '×', star: '★' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let last = 0;
  let m;
  const top = () => stack[stack.length - 1];
  const text = (s) => { if (s) top().children.push({ text: decodeEntities(s) }); };

  while ((m = re.exec(html))) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const i = stack.map((n) => n.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const node = { tag, attrs: parseAttrs(m[3]), children: [] };
      top().children.push(node);
      if (VOID.has(tag) || m[3].trim().endsWith('/')) continue;
      if (RAW_TEXT.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, last);
        const stop = end === -1 ? html.length : end;
        node.children.push({ text: tag === 'title' ? decodeEntities(html.slice(last, stop)) : html.slice(last, stop) });
        const close = html.indexOf('>', stop);
        last = re.lastIndex = close === -1 ? html.length : close + 1;
        continue;
      }
      stack.push(node);
    }
  }
  text(html.slice(last));
  return root;
}

function find(node, pred) {
  if (!node.children) return null;
  for (const c of node.children) {
    if (c.tag && pred(c)) return c;
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
}

function textOf(node) {
  if (node.text != null) return node.text;
  return (node.children || []).map(textOf).join('');
}

const squash = (s) => s.replace(/\s+/g, ' ');

function absolute(href, base) {
  try { return new URL(href, base).href; } catch { return href; }
}

function wrap(marker, inner) {
  const t = inner.trim();
  if (!t) return inner;
  const lead = inner.match(/^\s*/)[0] ? ' ' : '';
  const trail = inner.match(/\s*$/)[0] ? ' ' : '';
  return `${lead}${marker}${t}${marker}${trail}`;
}

function renderInline(node, ctx) {
  if (node.text != null) return squash(node.text);
  if (SKIP.has(node.tag) || node.attrs['aria-hidden'] === 'true' || node.attrs.hidden != null) return '';
  const inner = () => node.children.map((c) => renderInline(c, ctx)).join('');
  switch (node.tag) {
    case 'br': return '  \n';
    case 'wbr': return '';
    case 'strong': case 'b': return wrap('**', inner());
    case 'em': case 'i': return wrap('*', inner());
    case 'code': case 'kbd': return wrap('`', inner());
    case 'img': {
      const alt = squash(node.attrs.alt || '').trim();
      return alt && node.attrs.src ? `![${alt}](${absolute(node.attrs.src, ctx.base)})` : '';
    }
    case 'a': {
      const label = inner().trim();
      const href = node.attrs.href;
      if (!label) return '';
      if (!href) return label;
      return `[${label}](${absolute(href, ctx.base)})`;
    }
    default: return inner();
  }
}

// Render a node as a list of Markdown blocks.
function renderBlocks(node, ctx) {
  if (node.text != null) return [];
  if (SKIP.has(node.tag) || node.attrs['aria-hidden'] === 'true' || node.attrs.hidden != null) return [];

  const heading = /^h([1-6])$/.exec(node.tag);
  if (heading) {
    const t = renderInline(node, ctx).trim();
    return t ? [`${'#'.repeat(Number(heading[1]))} ${t}`] : [];
  }
  switch (node.tag) {
    case 'ul': case 'ol': return [renderList(node, ctx)].filter(Boolean);
    case 'summary': { const t = renderInline(node, ctx).trim(); return t ? [`**${t}**`] : []; }
    case 'figcaption': { const t = renderInline(node, ctx).trim(); return t ? [`*${t}*`] : []; }
    case 'blockquote': return renderChildren(node, ctx).map((b) => b.replace(/^/gm, '> '));
    case 'pre': return [`\`\`\`\n${textOf(node).replace(/\n$/, '')}\n\`\`\``];
    case 'hr': return ['---'];
    case 'a':
      if (hasBlockChild(node)) {
        // Card-style link wrapping a heading etc.: link the heading, keep the rest.
        const href = absolute(node.attrs.href || '', ctx.base);
        // Drop the "Read the guide →" affordance (class="more"); the heading is the link now.
        const children = node.children.filter((c) => !(c.attrs?.class || '').split(/\s+/).includes('more'));
        const blocks = renderChildren({ ...node, children }, ctx);
        const i = blocks.findIndex((b) => /^#{1,6} /.test(b));
        if (i === -1 || !node.attrs.href) return blocks;
        blocks[i] = blocks[i].replace(/^(#{1,6}) (.*)$/s, (_, h, t) => `${h} [${t}](${href})`);
        return blocks;
      }
    // fall through
    default:
      if (INLINE.has(node.tag)) { const t = renderInline(node, ctx).trim(); return t ? [t] : []; }
      return renderChildren(node, ctx);
  }
}

// Group inline runs into paragraphs; recurse into block children.
function renderChildren(node, ctx) {
  const blocks = [];
  let run = '';
  const flush = () => {
    const t = run.replace(/ *\n */g, '\n').replace(/[ \t]+/g, ' ').trim();
    if (t) blocks.push(t);
    run = '';
  };
  // A row of sibling <span>s (e.g. feature chips) reads best as a list.
  const elements = node.children.filter((c) => c.tag);
  const onlySpans =
    elements.length > 1 &&
    elements.every((c) => c.tag === 'span') &&
    node.children.every((c) => c.tag || !c.text.trim());
  if (onlySpans) {
    const items = elements.map((c) => renderInline(c, ctx).trim()).filter(Boolean);
    return items.length ? [items.map((t) => `- ${t}`).join('\n')] : [];
  }

  for (const c of node.children) {
    if (c.text != null || (INLINE.has(c.tag) && !hasBlockChild(c))) run += renderInline(c, ctx);
    else { flush(); blocks.push(...renderBlocks(c, ctx)); }
  }
  flush();

  // A bare step number followed by a heading → "### 1. Heading".
  for (let i = blocks.length - 2; i >= 0; i--) {
    const h = /^(#{1,6}) (.*)$/s.exec(blocks[i + 1]);
    if (/^\d+$/.test(blocks[i]) && h) blocks.splice(i, 2, `${h[1]} ${blocks[i]}. ${h[2]}`);
  }
  return blocks;
}

function hasBlockChild(node) {
  return (node.children || []).some((c) => c.tag && (!INLINE.has(c.tag) || hasBlockChild(c)));
}

function renderList(node, ctx) {
  const ordered = node.tag === 'ol';
  let n = Number(node.attrs.start) || 1;
  const items = [];
  for (const li of node.children) {
    if (li.tag !== 'li') continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const body = renderChildren(li, ctx).join('\n\n');
    if (!body) continue;
    const pad = ' '.repeat(marker.length);
    items.push(marker + body.replace(/\n(?=.)/g, `\n${pad}`));
  }
  return items.join('\n');
}

function yamlString(s) {
  return JSON.stringify(squash(s).trim());
}

export function htmlToMarkdown(html, url) {
  const doc = parse(html);
  const htmlEl = find(doc, (n) => n.tag === 'html');
  const title = find(doc, (n) => n.tag === 'title');
  const description = find(doc, (n) => n.tag === 'meta' && n.attrs.name === 'description');
  const canonical = find(doc, (n) => n.tag === 'link' && n.attrs.rel === 'canonical');
  const body = find(doc, (n) => n.tag === 'body') || doc;
  const ctx = { base: canonical?.attrs.href || url };

  const front = ['---'];
  if (title) front.push(`title: ${yamlString(textOf(title))}`);
  if (description?.attrs.content) front.push(`description: ${yamlString(description.attrs.content)}`);
  front.push(`url: ${yamlString(ctx.base)}`);
  if (htmlEl?.attrs.lang) front.push(`lang: ${yamlString(htmlEl.attrs.lang)}`);
  front.push('---');

  const blocks = renderBlocks(body, ctx);
  return `${front.join('\n')}\n\n${blocks.join('\n\n')}\n`;
}
