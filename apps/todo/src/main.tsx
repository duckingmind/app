import React from 'react'
import ReactDOM from 'react-dom/client'
import { createAppClient } from '@codex/proxy-app-sdk'

const app = createAppClient('app.proxy.local.todo', { localDevelopment: import.meta.env.DEV, localAppVersion: '0.1.0' })

function App() {
  const [profile, setProfile] = React.useState<string>('loading...')
  const [status, setStatus] = React.useState('ready')

  React.useEffect(() => {
    app.user.getProfile()
      .then((value) => setProfile(value.username || value.email || value.id))
      .catch((error) => setProfile(error.message))
  }, [])

  return (
    <main style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1>Todo Demo</h1>
      <p>User: {profile}</p>
      <p>Status: {status}</p>
      <button onClick={() => void app.storage.set('todo:last-opened', new Date().toISOString())}>
        Save session
      </button>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
