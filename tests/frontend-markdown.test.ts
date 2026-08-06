import { describe, it, expect } from 'vitest'
import { loadPublicScript } from './helpers/load-public-script.js'

const { renderMarkdown } = loadPublicScript<{ renderMarkdown: (t: string) => string }>(
  ['format.js', 'markdown.js'],
  '{ renderMarkdown }'
)

describe('renderMarkdown', () => {
  it('renders bold and italic inline markers', () => {
    expect(renderMarkdown('**Fő mintázatok** és *fenntartás*')).toBe(
      '<p><strong>Fő mintázatok</strong> és <em>fenntartás</em></p>'
    )
  })

  it('renders headings', () => {
    expect(renderMarkdown('# Cím\n## Alcím')).toBe('<h4>Cím</h4><h5>Alcím</h5>')
  })

  it('renders unordered and ordered lists', () => {
    expect(renderMarkdown('- egy\n- kettő')).toBe('<ul><li>egy</li><li>kettő</li></ul>')
    expect(renderMarkdown('1. egy\n2. kettő')).toBe('<ol><li>egy</li><li>kettő</li></ol>')
  })

  it('separates paragraphs on blank lines and keeps line breaks inside one', () => {
    expect(renderMarkdown('egy\nkettő\n\nhárom')).toBe('<p>egy<br>kettő</p><p>három</p>')
  })

  it('renders inline code without applying markdown inside it', () => {
    expect(renderMarkdown('`**nem** kövér`')).toBe('<p><code>**nem** kövér</code></p>')
  })

  it('renders fenced code blocks verbatim', () => {
    expect(renderMarkdown('```json\n{"a": 1}\n```')).toBe('<pre class="md-code"><code>{&quot;a&quot;: 1}</code></pre>')
  })

  it('does not apply markdown inside a fenced block', () => {
    expect(renderMarkdown('```\n- **x**\n# nem cím\n```')).toBe(
      '<pre class="md-code"><code>- **x**\n# nem cím</code></pre>'
    )
  })

  it('closes an unterminated fence instead of losing the text', () => {
    expect(renderMarkdown('```\nfélbehagyott')).toBe('<pre class="md-code"><code>félbehagyott</code></pre>')
  })

  it('escapes HTML so raw model output cannot inject markup (XSS)', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>'
    )
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>')
    expect(renderMarkdown('**<b>x</b>**')).toBe('<p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>')
  })

  it('escapes quotes and ampersands', () => {
    expect(renderMarkdown('a & "b" \'c\'')).toBe('<p>a &amp; &quot;b&quot; &#39;c&#39;</p>')
  })

  it('returns an empty string for empty or missing input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null as unknown as string)).toBe('')
  })
})
