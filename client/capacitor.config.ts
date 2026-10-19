import type { CapacitorConfig } from '@capacitor/cli';

const portalNative = process.env.CAPACITOR_PORTAL === '1';

const config: CapacitorConfig = {
  appId: portalNative ? 'com.tsogs.panorth' : 'com.tsogs.mtbilling',
  appName: portalNative ? 'PANORTH' : 'MT-Billing',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: portalNative ? '#020806' : '#0f172a',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: portalNative ? '#020806' : '#0f172a',
    },
  },
  android: {
    path: portalNative ? 'android-panorth' : 'android',
    allowMixedContent: true,
  },
};

export default config;
