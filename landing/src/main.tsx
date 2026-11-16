import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './access.css'
import './components/demo/demo.css'
import { startSmoothScroll } from './smoothScroll'

const stopSmoothScroll = startSmoothScroll()
if (import.meta.hot) import.meta.hot.dispose(stopSmoothScroll)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
