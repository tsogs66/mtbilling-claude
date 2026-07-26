import { db } from './db.js';

const SYMBOLS: Record<string, string> = { PHP: '₱', USD: '$', EUR: '€' };

/** Reads the panel's configured currency (Settings → Panel Settings) and returns its symbol. */
export function currentCurrencySymbol(): string {
  try {
    const row = db.prepare('SELECT currency FROM app_settings WHERE id = 1').get() as { currency?: string } | undefined;
    return SYMBOLS[String(row?.currency || 'PHP').toUpperCase()] || SYMBOLS.PHP;
  } catch {
    return SYMBOLS.PHP;
  }
}

/** Format an amount with the panel's configured currency symbol. */
export function formatCurrency(n: number): string {
  return `${currentCurrencySymbol()}${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
