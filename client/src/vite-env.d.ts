/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  /** Set to 1 for PANORTH subscriber Capacitor builds */
  readonly VITE_NATIVE_PORTAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
