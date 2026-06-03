// Single source of truth for clipboard writes from message bubbles. Three
// flavours: copyRich (HTML + plain), copyRaw (plain), copyImage (PNG blob).
//
// Each one tries the modern async Clipboard API first, and on failure
// (insecure context, no ClipboardItem, browser refusal) falls back to the
// legacy document.execCommand('copy') selection trick — which is what lets
// this whole thing work over plain HTTP on a LAN where the secure-context
// requirement of navigator.clipboard.write() would otherwise gate us out.
//
// Ported from copipasta as-is (copy strategies are stack-independent).
export function useClipboard() {
  const toast = useToast()

  async function copyRich(msg: { bodyText: string | null, bodyHtml: string | null }) {
    const text = msg.bodyText ?? ''
    const html = msg.bodyHtml

    if (html && window.isSecureContext && typeof ClipboardItem !== 'undefined') {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })])
        toast.add({ title: 'Copied' })
        return
      } catch { /* fall through */ }
    }

    if (html && execCopyHtml(html)) {
      toast.add({ title: 'Copied' })
      return
    }

    if (await copyTextAnyContext(text)) {
      toast.add({ title: 'Copied' })
      return
    }
    toast.add({ title: 'Could not copy', color: 'error' })
  }

  async function copyRaw(msg: { bodyText: string | null }) {
    if (await copyTextAnyContext(msg.bodyText ?? '')) {
      toast.add({ title: 'Copied (raw)' })
      return
    }
    toast.add({ title: 'Could not copy', color: 'error' })
  }

  async function copyImage(url: string, mime: string) {
    // Modern path — requires HTTPS/localhost.
    if (window.isSecureContext && typeof ClipboardItem !== 'undefined') {
      try {
        const blob = await (await fetch(url)).blob()
        await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })])
        toast.add({ title: 'Copied image' })
        return
      } catch { /* fall through */ }
    }

    // Legacy path — works on plain HTTP. Browser copies the selected <img>
    // as a real PNG blob. We need to load the image first so the browser has
    // bitmap data, not just a URL reference.
    try {
      const img = await loadImageElement(url)
      document.body.appendChild(img)
      const ok = selectAndCopy(img)
      document.body.removeChild(img)
      if (ok) {
        toast.add({ title: 'Copied image' })
        return
      }
    } catch { /* fall through */ }

    // Last resort: copy the URL so the user can at least paste a link.
    if (await copyTextAnyContext(url)) {
      toast.add({
        title: 'Copied image URL',
        description: 'Your browser blocked the image bytes — pasted as a link instead.'
      })
      return
    }
    toast.add({ title: 'Could not copy image', color: 'error' })
  }

  return { copyRich, copyRaw, copyImage }
}

// --- helpers ---

async function copyTextAnyContext(text: string): Promise<boolean> {
  if (window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through */ }
  }
  return execCopyText(text)
}

function execCopyText(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  // Off-screen but still selectable.
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  document.body.removeChild(ta)
  return ok
}

function execCopyHtml(html: string): boolean {
  // contenteditable holds rendered HTML; the browser preserves formatting
  // when copying the live DOM, not the source string.
  const div = document.createElement('div')
  div.contentEditable = 'true'
  div.innerHTML = html
  div.style.position = 'fixed'
  div.style.top = '0'
  div.style.left = '-9999px'
  document.body.appendChild(div)
  const range = document.createRange()
  range.selectNodeContents(div)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  sel?.removeAllRanges()
  document.body.removeChild(div)
  return ok
}

function selectAndCopy(node: Node): boolean {
  const range = document.createRange()
  range.selectNode(node)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  sel?.removeAllRanges()
  return ok
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img')
    // Same-origin /api/clipboard/files/* so CORS isn't an issue, but set the
    // attr anyway for clarity — browsers refuse to copy tainted canvases.
    img.crossOrigin = 'anonymous'
    img.style.position = 'fixed'
    img.style.left = '-9999px'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}
