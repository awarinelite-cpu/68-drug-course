import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles.css'
import App from './App.jsx'
import { installEmrBridge } from './lib/emrBridge.js'
import { applyViewMode, initTextScale } from './lib/viewMode.js'

applyViewMode()
initTextScale()
// The browser applies the viewport meta a moment after load; re-measure once it has.
window.addEventListener('load', () => setTimeout(initTextScale, 100))
installEmrBridge()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
