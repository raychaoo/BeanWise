import { APP_NAME } from '../../shared/app'

export default function App() {
  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p id="preload-app-name">{window.beanwise.appName}</p>
    </main>
  )
}
