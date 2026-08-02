import { useEffect, useState } from 'react';

export type PortalThemeId = 'matrix' | 'orbital';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mq = window.matchMedia?.('(display-mode: standalone)')?.matches;
  const ios = (navigator as any).standalone === true;
  return Boolean(mq || ios);
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  const chrome = /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return iOS && webkit && !chrome;
}

function normalizePortalTheme(theme?: string | null): PortalThemeId {
  return theme === 'orbital' ? 'orbital' : 'matrix';
}

/** Swap main manifest for the portal one while /portal is open. */
export function usePortalManifest(theme: PortalThemeId = 'matrix') {
  const portalTheme = normalizePortalTheme(theme);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('portal-route');
    html.setAttribute('data-portal-theme', portalTheme);

    // Suspend panel themes (dark/isptech/blueglass…) so their remaps
    // cannot override the portal theme.
    const prevDataTheme = html.getAttribute('data-theme');
    html.removeAttribute('data-theme');

    const link =
      document.querySelector<HTMLLinkElement>('link[rel="manifest"]') ||
      (() => {
        const el = document.createElement('link');
        el.rel = 'manifest';
        document.head.appendChild(el);
        return el;
      })();
    const prev = link.getAttribute('href');
    link.setAttribute('href', '/portal-manifest.webmanifest');
    const prevScheme = html.style.getPropertyValue('color-scheme');
    html.style.setProperty('color-scheme', 'dark');
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    const prevTheme = metaTheme?.getAttribute('content') || '';
    metaTheme?.setAttribute('content', portalTheme === 'orbital' ? '#030b18' : '#020806');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/portal-sw.js').catch(() => undefined);
    }

    return () => {
      html.classList.remove('portal-route');
      html.removeAttribute('data-portal-theme');
      if (prevDataTheme) html.setAttribute('data-theme', prevDataTheme);
      else html.removeAttribute('data-theme');
      if (prevScheme) html.style.setProperty('color-scheme', prevScheme);
      else html.style.removeProperty('color-scheme');
      if (prev) link.setAttribute('href', prev);
      else link.setAttribute('href', '/manifest.webmanifest');
      if (metaTheme && prevTheme) metaTheme.setAttribute('content', prevTheme);
    };
  }, [portalTheme]);
}

export function usePortalInstall(theme: PortalThemeId = 'matrix') {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);
  const [iosHint, setIosHint] = useState(false);

  usePortalManifest(theme);

  useEffect(() => {
    if (isStandalone()) {
      setInstalled(true);
      return;
    }
    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
      setIosHint(false);
    };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const canInstall = !installed && (Boolean(deferred) || isIosSafari());

  const install = async () => {
    if (deferred) {
      await deferred.prompt();
      try {
        const choice = await deferred.userChoice;
        if (choice.outcome === 'accepted') setInstalled(true);
      } catch {
        /* ignore */
      }
      setDeferred(null);
      return;
    }
    if (isIosSafari()) {
      setIosHint(true);
    }
  };

  return {
    installed,
    canInstall,
    iosHint,
    dismissIosHint: () => setIosHint(false),
    install,
    /** Show button even before bip fires (Android may delay); iOS always shows. */
    showInstallButton: !installed,
  };
}
