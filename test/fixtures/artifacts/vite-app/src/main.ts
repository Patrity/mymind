// Two client routes via history.pushState; relative fetch works under /artifact/<slug>/.
const base = location.pathname.replace(/settings\/?$/, '')
const render = () => { document.getElementById('route')!.textContent = /settings\/?$/.test(location.pathname) ? 'Settings' : 'Home' }
document.querySelectorAll('a[data-link]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault()
  history.pushState({}, '', (a as HTMLAnchorElement).textContent === 'Home' ? base : base + 'settings')
  render()
}))
addEventListener('popstate', render)
render()
fetch(base + 'data/x.json').then(r => r.json()).then((j) => { document.getElementById('value')!.textContent = String(j.value) })
  .catch(() => { document.getElementById('value')!.textContent = 'error' })
