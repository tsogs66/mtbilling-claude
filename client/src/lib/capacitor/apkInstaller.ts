import { registerPlugin } from '@capacitor/core';

export interface ApkInstallerPlugin {
  install(options: { uri: string }): Promise<{ ok: boolean }>;
}

export const ApkInstaller = registerPlugin<ApkInstallerPlugin>('ApkInstaller');
