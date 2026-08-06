// Minimal, XSS-safe markdown renderer for LLM output (evaluation texts).
// Safety rule: the input is escaped FIRST, and only tags produced here are added
// afterwards — model output can never contribute markup. No DOM access, so this
// is unit-tested without a browser environment.

const MD_INLINE_CODE = /`([^`]+)`/;

function renderMarkdown(text) {
  if (text === null || text === undefined) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

  const blocks = [];
  let paragraph = [];
  let list = null; // { tag: 'ul' | 'ol', items: string[] }

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push('<p>' + paragraph.join('<br>') + '</p>');
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + i + '</li>').join('') + '</' + list.tag + '>');
      list = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };
  const pushListItem = (tag, content) => {
    flushParagraph();
    if (!list || list.tag !== tag) {
      flushList();
      list = { tag, items: [] };
    }
    list.items.push(content);
  };

  let fence = null; // collected lines of an open ``` block

  for (const line of lines) {
    const trimmed = line.trim();

    if (fence !== null) {
      if (trimmed.startsWith('```')) {
        blocks.push('<pre class="md-code"><code>' + escapeHtml(fence.join('\n')) + '</code></pre>');
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (trimmed.startsWith('```')) {
      flushAll();
      fence = [];
      continue;
    }

    if (trimmed === '') {
      flushAll();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 3);
      blocks.push('<h' + (3 + level) + '>' + renderInline(heading[2]) + '</h' + (3 + level) + '>');
      continue;
    }

    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      pushListItem('ul', renderInline(bullet[1]));
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ordered) {
      pushListItem('ol', renderInline(ordered[1]));
      continue;
    }

    flushList();
    paragraph.push(renderInline(trimmed));
  }

  // An unterminated fence still shows its content: losing model output silently
  // would be worse than a slightly odd-looking block.
  if (fence !== null) blocks.push('<pre class="md-code"><code>' + escapeHtml(fence.join('\n')) + '</code></pre>');
  flushAll();
  return blocks.join('');
}

/**
 * Applies inline markers on escaped text. Code spans are split out first so that
 * `**literal**` inside backticks stays literal.
 */
function renderInline(raw) {
  const escaped = escapeHtml(raw);
  let rest = escaped;
  let out = '';

  let match = rest.match(MD_INLINE_CODE);
  while (match) {
    out += renderEmphasis(rest.slice(0, match.index)) + '<code>' + match[1] + '</code>';
    rest = rest.slice(match.index + match[0].length);
    match = rest.match(MD_INLINE_CODE);
  }
  return out + renderEmphasis(rest);
}

function renderEmphasis(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_]+)_(?![_\w])/g, '$1<em>$2</em>');
}
