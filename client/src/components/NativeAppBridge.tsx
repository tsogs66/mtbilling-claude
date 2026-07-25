import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { registerSidebarControl } from '../lib/nativeShell';
import { useLayout } from './Layout';

/** Wires native Android behaviors after the router + layout are mounted. */
export default function NativeAppBridge() {
  const { sidebarOpen, setSidebarOpen } = useLayout();
  const location = useLocation();

  useEffect(() => {
    registerSidebarControl(sidebarOpen, setSidebarOpen);
  }, [sidebarOpen, setSidebarOpen]);

  // Close mobile drawer on route change
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, setSidebarOpen]);

  return null;
}
