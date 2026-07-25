/** Copy text to the clipboard. Works over HTTP (non-secure) via execCommand fallback. */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? '');
  if (!value) return false;

  // navigator.clipboard is unreliable / blocked on plain HTTP (typical Proxmox LXC panels).
  const secure =
    typeof window === 'undefined' || window.isSecureContext !== false;

  if (secure) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      /* fall through to legacy path */
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = 'none';
    ta.style.outline = 'none';
    ta.style.boxShadow = 'none';
    ta.style.background = 'transparent';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Copy text; if clipboard APIs fail, open a prompt so the user can copy manually. */
export async function copyTextOrPrompt(text: string, promptLabel = 'Copy this link:'): Promise<boolean> {
  const value = String(text ?? '');
  if (!value) return false;
  if (await copyText(value)) return true;
  try {
    window.prompt(promptLabel, value);
  } catch {
    /* ignore */
  }
  return false;
}
