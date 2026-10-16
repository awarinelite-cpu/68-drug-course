import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles.css'
import App from './App.jsx'
import { installEmrBridge } from './lib/emrBridge.js'
import { applyViewMode } from './lib/viewMode.js'

applyViewMode()
installEmrBridge()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
