import React from 'react'
import ReactDOM from 'react-dom/client'
import MobileDemo from './components/demo/MobileDemo'
import type { DemoScreen } from './components/demo/demoModel'
import './index.css'
import './components/demo/demo.css'

const query = new URLSearchParams(location.search)
const screens: DemoScreen[] = ['welcome', 'home', 'earn', 'review']
const requested = query.get('screen') as DemoScreen
const initialScreen = screens.includes(requested) ? requested : 'welcome'
if (query.get('capture') === '1')
  document.documentElement.classList.add('is-demo-capture')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main className="demo-standalone">
      <div>
        <MobileDemo initialScreen={initialScreen} />
        <p className="demo-standalone-note">
          Interactive Gizu demo. All balances, rates and transactions are
          illustrative. No real funds move.
          <br />
          <a href="/" className="inline-flex min-h-11 items-center text-neon">
            Back to Gizu
          </a>
        </p>
      </div>
    </main>
  </React.StrictMode>
)
