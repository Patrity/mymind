const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript / TypeScript
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',

  // Web
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  liquid: 'liquid',

  // Data / Config
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',
  ini: 'ini',
  env: 'dotenv',
  properties: 'properties',
  proto: 'protobuf',

  // Markdown / Text
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  txt: 'plaintext',
  text: 'plaintext',
  log: 'plaintext',

  // Programming — Python
  py: 'python',
  pyw: 'python',

  // Programming — Ruby
  rb: 'ruby',

  // Programming — PHP
  php: 'php',
  phtml: 'php',

  // Programming — JVM
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  sc: 'scala',
  groovy: 'groovy',
  gradle: 'groovy',

  // Programming — Systems
  rs: 'rust',
  go: 'go',
  swift: 'swift',
  dart: 'dart',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  d: 'd',
  di: 'd',
  cr: 'crystal',

  // Programming — .NET
  fs: 'fsharp',
  fsx: 'fsharp',
  fsi: 'fsharp',
  vb: 'vb',
  vbs: 'vb',

  // Programming — Scripting
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  jl: 'julia',
  coffee: 'coffeescript',

  // Programming — Functional
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'haskell',
  lhs: 'haskell',
  elm: 'elm',
  ml: 'ocaml',
  mli: 'ocaml',
  scm: 'scheme',
  ss: 'scheme',
  lisp: 'commonlisp',
  cl: 'commonlisp',

  // Programming — Other
  nim: 'plaintext',
  nims: 'plaintext',
  f: 'fortran',
  f90: 'fortran',
  f95: 'fortran',
  pas: 'pascal',
  pp: 'pascal',
  tcl: 'tcl',
  v: 'verilog',
  sv: 'verilog',
  vhd: 'vhdl',
  vhdl: 'vhdl',
  hx: 'haxe',
  hxml: 'haxe',

  // Mobile
  m: 'objective-c',
  mm: 'objective-c',

  // Shell / Infra
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'shell',
  cmd: 'shell',
  dockerfile: 'dockerfile',
  cmake: 'cmake',
  nginx: 'nginx',
  conf: 'nginx',
  puppet: 'puppet',
  pp2: 'puppet',

  // Database / Query
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  cypher: 'cypher',
  cyp: 'cypher',
  sparql: 'sparql',
  rq: 'sparql',

  // WebAssembly
  wat: 'wast',
  wast: 'wast',

  // Markup
  tex: 'latex',
  latex: 'latex',
  textile: 'textile',

  // Other
  diff: 'diff',
  patch: 'diff',
  makefile: 'makefile',
  mk: 'makefile',
  styl: 'stylus',
  pug: 'pug',
  jade: 'pug'
}

export function getLanguageFromPath(path: string): string {
  const name = path.split('/').pop()!.toLowerCase()
  const lastDot = name.lastIndexOf('.')
  if (lastDot === -1) return 'plaintext'
  return EXTENSION_TO_LANGUAGE[name.slice(lastDot + 1)] ?? 'plaintext'
}
