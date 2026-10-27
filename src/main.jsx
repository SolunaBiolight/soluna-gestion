import { StrictMode, useState, useEffect, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

// Arranque liviano (27/oct/2026, pre-lanzamiento con pauta): quien llega SIN sesión a la portada
// ("/", sin hash ni parámetros propios de la app) ve la landing sola (src/Landing.jsx, unos KB) y la
// app completa (App.jsx, ~2,9 MB + Firebase) se baja recién al tocar "Iniciar sesión" / "Probar gratis".
// Con sesión guardada, o cualquier otro link (#/login, portales por token, vueltas de OAuth,
// ?ia_auth, ?invitado, ?shopify_…), arranca la app como siempre.
const App = lazy(() => import('./App.jsx'))

const PARAMS_LANDING = /^(ref|utm_[a-z]+|fbclid|gclid|ttclid|msclkid|igshid)$/i
function esPortadaPublica() {
  try {
    const h = window.location.hash || ''
    if (h && h !== '#' && h !== '#/') return false
    if (window.location.pathname !== '/') return false
    for (const k of new URLSearchParams(window.location.search).keys()) if (!PARAMS_LANDING.test(k)) return false
    if (sessionStorage.getItem('growith_mcp_rid')) return false
    return true
  } catch (_) { return false }
}
// Firebase guarda la sesión en IndexedDB (firebaseLocalStorageDb): si hay un usuario, va directo a la app.
function haySesionGuardada() {
  return new Promise(res => {
    let listo = false; const fin = v => { if (!listo) { listo = true; res(v) } }
    setTimeout(() => fin(false), 600)
    try {
      const rq = indexedDB.open('firebaseLocalStorageDb')
      rq.onerror = () => fin(false)
      rq.onupgradeneeded = () => { try { rq.transaction.abort() } catch (_) {} fin(false) }
      rq.onsuccess = () => {
        const db = rq.result
        try {
          if (!db.objectStoreNames.contains('firebaseLocalStorage')) { db.close(); return fin(false) }
          const g = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAllKeys()
          g.onsuccess = () => { db.close(); fin((g.result || []).some(k => String(k).startsWith('firebase:authUser'))) }
          g.onerror = () => { db.close(); fin(false) }
        } catch (_) { try { db.close() } catch (__) {} fin(false) }
      }
    } catch (_) { fin(false) }
  })
}
// Código de referido (?ref=CODIGO): mismo guardado que App.jsx, porque acá la app todavía no cargó.
try {
  const rp = new URLSearchParams(window.location.search).get('ref')
  if (rp && /^[A-Za-z0-9]{6,12}$/.test(rp)) localStorage.setItem('growith_ref', rp.toUpperCase())
} catch (_) {}

function Splash() {
  return <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1117' }}>
    <img src="/logo-color.png" alt="Growith" style={{ width: 96, height: 96, objectFit: 'contain' }} />
  </div>
}

function Raiz({ modo }) {
  const [vista, setVista] = useState(modo)
  const [Landing, setLanding] = useState(null)
  useEffect(() => {
    if (vista !== 'landing') return
    Promise.all([import('./Landing.jsx'), import('./shared.jsx')])
      .then(([l, sh]) => setLanding(() => ({ Page: l.LandingPage, T: (() => { try { return localStorage.getItem('growith_theme') === 'light' ? sh.LIGHT : sh.DARK } catch (_) { return sh.DARK } })() })))
      .catch(() => setVista('app'))
    // Precarga la app de fondo cuando el navegador esté libre, así "Iniciar sesión" responde rápido.
    const pre = () => import('./App.jsx').catch(() => {})
    const t = window.requestIdleCallback ? window.requestIdleCallback(pre, { timeout: 6000 }) : setTimeout(pre, 4000)
    return () => { try { window.cancelIdleCallback ? window.cancelIdleCallback(t) : clearTimeout(t) } catch (_) {} }
  }, [vista])
  useEffect(() => { // volver atrás del login a la portada, o ir a #/login desde un link
    const f = () => { if (vista === 'landing' && window.location.hash && window.location.hash !== '#/') setVista('app') }
    window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f)
  }, [vista])
  if (vista === 'landing') {
    if (!Landing) return <Splash />
    const { Page, T } = Landing
    document.body.style.background = T.bg
    return <Page T={T} onLogin={() => { try { sessionStorage.setItem('growith_ir_login', '1'); window.location.hash = '#/login' } catch (_) {} window.scrollTo(0, 0); setVista('app') }} />
  }
  return <Suspense fallback={<Splash />}><App /></Suspense>
}

async function arrancar() {
  const modo = esPortadaPublica() && !(await haySesionGuardada()) ? 'landing' : 'app'
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <Raiz modo={modo} />
    </StrictMode>,
  )
}
arrancar()
