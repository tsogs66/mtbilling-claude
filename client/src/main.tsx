import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { RouterProvider } from './context/RouterContext';
import { CompanyProvider } from './context/CompanyContext';
import { ThemeProvider } from './context/ThemeContext';
import ServerSetup from './pages/ServerSetup';
import { isNativeApp, needsServerSetup } from './config';
import { initNativeShell } from './lib/nativeShell';
import 'leaflet/dist/leaflet.css';
import './index.css';

async function hideNativeSplash() {
  if (!isNativeApp()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch {
    /* optional plugin */
  }
}

function Root() {
  const [ready, setReady] = useState(!needsServerSetup());

  useEffect(() => {
    if (isNativeApp()) initNativeShell();
    void hideNativeSplash();
  }, []);

  if (!ready) {
    return <ServerSetup onReady={() => setReady(true)} />;
  }

  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <CompanyProvider>
            <RouterProvider>
              <App />
            </RouterProvider>
          </CompanyProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
