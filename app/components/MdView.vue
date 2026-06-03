<script setup lang="ts">
// Shared markdown renderer. Wraps @nuxtjs/mdc so we can theme code blocks
// + restyle prose without touching every caller. Use everywhere we render
// text that may contain markdown (document preview, memory cards, task bodies).
defineProps<{
  source: string
  inline?: boolean
}>()
</script>

<template>
  <div :class="inline ? 'mm-md mm-md-inline' : 'mm-md'">
    <MDC :value="source" />
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
.mm-md-inline p {
  display: inline;
  margin: 0;
}
</style>
