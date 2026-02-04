import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AppStacked from './AppStacked.jsx'

// Use ?stacked in URL to switch to stacked layout
const useStacked = window.location.search.includes('stacked')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {useStacked ? <AppStacked /> : <App />}
  </StrictMode>,
)
