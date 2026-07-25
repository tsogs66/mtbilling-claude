/**
 * Capacitor native shell behaviors for Android/iOS WebView builds.
 */
import { isNativeApp } from '../config';

let sidebarOpen = false;
let setSidebarOpenFn: ((open: boolean) => void) | null = null;
let moreMenuOpen = false;
let closeMoreMenuFn: (() => void) | null = null;
let nativeSheetOpen = false;
let closeNativeSheetFn: (() => void) | null = null;

/** Layout registers sidebar state so the hardware back button can close the drawer. */
export function registerSidebarControl(open: boolean, setter: (v: boolean) => void) {
  sidebarOpen = open;
  setSidebarOpenFn = setter;
}

/** Bottom "More" sheet on native Android — hardware back closes it first. */
export function registerMoreMenuControl(open: boolean, close: () => void) {
  moreMenuOpen = open;
  closeMoreMenuFn = close;
}

/** Live traffic / other full-screen sheets — back button closes before More menu. */
export function registerNativeSheet(open: boolean, close: () => void) {
  nativeSheetOpen = open;
  closeNativeSheetFn = close;
}

export function initNativeShell() {
  if (!isNativeApp()) return;

  document.documentElement.classList.add('native-app');

  void initKeyboard();
  void initBackButton();
  void initStatusBar();
}

async function initKeyboard() {
  try {
    const { Keyboard, KeyboardResize } = await import('@capacitor/keyboard');
    await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
    Keyboard.addListener('keyboardWillShow', () => {
      document.documentElement.classList.add('keyboard-open');
    });
    Keyboard.addListener('keyboardWillHide', () => {
      document.documentElement.classList.remove('keyboard-open');
    });
  } catch {
    /* optional plugin */
  }
}

async function initStatusBar() {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0f172a' });
  } catch {
    /* optional plugin */
  }
}

async function initBackButton() {
  try {
    const { App } = await import('@capacitor/app');
    App.addListener('backButton', ({ canGoBack }) => {
      if (nativeSheetOpen && closeNativeSheetFn) {
        closeNativeSheetFn();
        return;
      }
      if (moreMenuOpen && closeMoreMenuFn) {
        closeMoreMenuFn();
        return;
      }
      if (sidebarOpen && setSidebarOpenFn) {
        setSidebarOpenFn(false);
        return;
      }
      if (canGoBack && window.history.length > 1) {
        window.history.back();
        return;
      }
      void App.minimizeApp();
    });
  } catch {
    /* optional plugin */
  }
}
