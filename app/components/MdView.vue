<script setup lang="ts">
// Shared markdown renderer. Wraps @nuxtjs/mdc so we can theme code blocks
// + restyle prose without touching every caller. Use everywhere we render
// text that may contain markdown (document preview, memory cards, task bodies).
//
// cacheKey: REQUIRED for content that STREAMS (grows after mount). MDC keys its
// useAsyncData on hash(value) at setup time — for streaming text that's the hash
// of the first delta, so two messages starting with the same token collide on one
// asyncData record and render each other's content (live-verified on /agent).
//
// Cycle 88: every caller renders STORED content (documents, triage cards, shared docs, config
// previews, clipboard pastes) that may be attacker-influenced, so the parsed tree goes through
// hardenMdcBody (app/lib/markdown/stored-harden.ts) before it renders: no remote images (they
// become links), no raw-HTML/MDC components that fetch, no style/on* attributes. The frontmatter
// `data` is NOT passed to the renderer — `mdc.components` in frontmatter can remap tags.
import type { MDCRoot } from '@nuxtjs/mdc'
import { hardenMdcBody, type MdcNode } from '~/lib/markdown/stored-harden'

defineProps<{
  source: string
  inline?: boolean
  cacheKey?: string
}>()

const origin = useRequestURL().origin
const harden = (body: MDCRoot) => hardenMdcBody(body as MdcNode, { origin }) as MDCRoot
</script>

<template>
  <div :class="inline ? 'mm-md mm-md-inline' : 'mm-md'">
    <MDC
      v-slot="{ body }"
      :value="source"
      :cache-key="cacheKey"
    >
      <MDCRenderer
        v-if="body"
        :body="harden(body)"
        :data="{}"
      />
    </MDC>
  </div>
</template>

<style>
.mm-md {
  font-size: 0.875rem;
  line-height: 1.5;
  word-break: break-word;
}
.mm-md > :first-child {
  margin-top: 0;
}
.mm-md > :last-child {
  margin-bottom: 0;
}
.mm-md p,
.mm-md > div p {
  margin-top: 0.5em !important;
  margin-bottom: 0.5em !important;
  line-height: 1.5 !important;
}
.mm-md > div > :first-child,
.mm-md p:first-child {
  margin-top: 0 !important;
}
.mm-md > div > :last-child,
.mm-md p:last-child {
  margin-bottom: 0 !important;
}
.mm-md h1, .mm-md h2, .mm-md h3, .mm-md h4 {
  font-weight: 600;
  margin: 0.6em 0 0.3em;
  line-height: 1.3;
}
.mm-md h1 { font-size: 1.25rem; }
.mm-md h2 { font-size: 1.125rem; }
.mm-md h3 { font-size: 1rem; }
.mm-md ul, .mm-md ol {
  margin: 0.4em 0;
  padding-left: 1.4em;
}
.mm-md li {
  margin: 0.1em 0;
}
.mm-md a {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.mm-md code {
  background: var(--ui-bg-elevated);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-size: 0.85em;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
.mm-md pre {
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
  padding: 0.75em 1em;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0.6em 0;
}
.mm-md pre code {
  background: transparent;
  padding: 0;
  font-size: 0.8125rem;
}
.mm-md blockquote {
  border-left: 3px solid var(--ui-border);
  margin: 0.5em 0;
  padding-left: 0.85em;
  color: var(--ui-text-muted);
}
.mm-md img {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  margin: 0.5em 0;
}
.mm-md table {
  border-collapse: collapse;
  margin: 0.6em 0;
}
.mm-md th, .mm-md td {
  border: 1px solid var(--ui-border);
  padding: 0.3em 0.6em;
  font-size: 0.85em;
}
.mm-md hr {
  border: none;
  border-top: 1px solid var(--ui-border);
  margin: 0.8em 0;
}
.mm-md .mm-md-blocked-img {
  font-size: 0.85em;
  color: var(--ui-text-muted);
}
/* Shiki token colours: the highlighter's own <style> block is dropped with every other <style>
   (hardenMdcBody), so its fixed theme rules live here; the per-token colours are inline
   --shiki-* variables, which hardenMdcBody keeps. */
.mm-md .shiki span {
  color: var(--shiki-default);
  background: var(--shiki-default-bg);
  font-style: var(--shiki-default-font-style);
  font-weight: var(--shiki-default-font-weight);
  text-decoration: var(--shiki-default-text-decoration);
}
.dark .mm-md .shiki span {
  color: var(--shiki-dark);
  background: var(--shiki-dark-bg);
  font-style: var(--shiki-dark-font-style);
  font-weight: var(--shiki-dark-font-weight);
  text-decoration: var(--shiki-dark-text-decoration);
}
.mm-md-inline p {
  display: inline;
  margin: 0;
}
</style>
