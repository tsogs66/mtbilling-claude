/** Self-help reconnect + Wi‑Fi guides for common Huawei ONTs used by PANORTH. */

export type OntGuide = {
  id: string;
  model: string;
  blurb: string;
  steps: string[];
  tips: string[];
  /** Optional: change SSID / Wi‑Fi password (2.4G + 5G). */
  wifiSteps?: string[];
  wifiTips?: string[];
};

/**
 * Shared Wi‑Fi SSID/password steps for OptiXstar EG8145X6-10 & EG8041X6-10
 * on firmware R022 / R024 (English web UI labels).
 */
export const OPTIXSTAR_WIFI_SSID_STEPS: string[] = [
  'Connect a phone or laptop to the ONT Wi‑Fi (current SSID on the sticker) or plug a LAN cable into any LAN port.',
  'Open a browser and go to http://192.168.100.1 (try http://192.168.1.1 if that does not load).',
  'Log in with the username and password printed on the ONT sticker (common user login: root / adminHW). Do not change WAN / Internet / PON settings.',
  'Open Network → WLAN (on some builds: Advanced → WLAN).',
  '2.4 GHz — open 2.4G Basic Network Settings (or WLAN Basic Configuration → 2.4GHz tab).',
  'Turn Enable WLAN / SSID on. Set SSID Name to your 2.4G network name (e.g. MyHome-2.4G).',
  'Set Authentication Mode to WPA2 PreSharedKey or WPA/WPA2-PSK. Set Encryption Mode to AES (or TKIP&AES).',
  'In WPA PreSharedKey, enter the new 2.4G password (8–63 characters, mix of letters and numbers). Click Apply / Submit.',
  '5 GHz — open 5G Basic Network Settings (or the 5GHz tab).',
  'Enable SSID. Set SSID Name for 5G (e.g. MyHome-5G — use a different name from 2.4G so phones can pick the right band).',
  'Use the same Authentication / Encryption as 2.4G. Set WPA PreSharedKey to your new 5G password (can match 2.4G or differ). Click Apply / Submit.',
  'On each device: forget the old Wi‑Fi, then join the new 2.4G and/or 5G SSID with the new password. Prefer 5G when close to the ONT for speed.',
];

export const OPTIXSTAR_WIFI_SSID_TIPS: string[] = [
  'Menus on R022 and R024 are the same idea; wording may be “2.4G Basic Network Settings” vs “2.4GHz Basic”.',
  'If login fails, try sticker credentials only — ISP-locked telecomadmin access is for support, not home Wi‑Fi changes.',
  'Do not press Reset — that wipes Wi‑Fi and can break OLT registration until support re-provisions.',
  'If the page asks to reboot WLAN after Apply, allow it and wait ~1 minute before reconnecting.',
];

export const HUAWEI_ONT_GUIDES: OntGuide[] = [
  {
    id: '8145v5',
    model: 'Huawei EchoLife HG8145V5',
    blurb: 'Common dual-band Wi‑Fi ONT (fiber modem + router).',
    steps: [
      'Confirm the fiber patch cord is fully seated in the SC/APC port (click) and not bent sharply.',
      'Check the LOS LED: off = fiber OK; red/blinking = no optical signal — contact support.',
      'PON / AUTH should be steady (not blinking forever). Blinking often means OLT auth / registration issue.',
      'Power-cycle: unplug the power adapter for 30 seconds, then plug back in. Wait 2–3 minutes for full boot.',
      'Connect to Wi‑Fi SSID printed on the sticker (or your renamed SSID). Default Wi‑Fi password is usually on the same label.',
      'If Wi‑Fi works but internet does not, forget the network on your phone and reconnect, or reboot the ONT again.',
      'Web UI (advanced): connect via LAN or Wi‑Fi, open http://192.168.100.1 (or 192.168.1.1), login with the sticker credentials, check Internet / WAN status.',
    ],
    tips: [
      'Do not press the Reset hole unless support asks — it wipes Wi‑Fi names and ISP settings.',
      'Keep the ONT upright with ventilation clear; overheating causes random disconnects.',
    ],
    wifiSteps: [
      'Connect to the ONT Wi‑Fi or LAN, then open http://192.168.100.1 and log in with the sticker username/password.',
      'Go to Network → WLAN (or Advanced → WLAN).',
      '2.4G: open 2.4G Basic / 2.4GHz settings → set SSID Name, Authentication = WPA2-PSK, Encryption = AES, WPA PreSharedKey = new password → Apply.',
      '5G: open 5G Basic / 5GHz settings → set SSID Name, same security, new password → Apply.',
      'Forget the old network on phones/laptops and reconnect to the new SSIDs.',
    ],
    wifiTips: [
      'HG8145V5 menus may say “SSID Configuration” instead of “Basic Network Settings”.',
      'Avoid factory reset — ask support if you are locked out of the web page.',
    ],
  },
  {
    id: '8041x6-10',
    model: 'Huawei OptiXstar EG8041X6-10',
    blurb: 'Wi‑Fi 6 ONT (firmware R022 / R024) — dual-band SSID & password change supported.',
    steps: [
      'Seat the fiber firmly; LOS must be off. PON should become steady after boot.',
      'Power-cycle 30 seconds if LOS is off but internet is still down.',
      'Use the 5 GHz SSID for speed when you are close to the ONT; 2.4 GHz for farther rooms.',
      'If only one band works, reboot once more — dual-band radios finish init after PON sync.',
      'Optional UI: http://192.168.100.1 — verify WAN is Connected and IPv4 address is present.',
      'Still offline after 3 minutes? Note LOS/PON/NET LED states and open a support ticket with a photo.',
    ],
    tips: [
      'Wi‑Fi 6 clients need WPA2/WPA3; very old devices may need the 2.4 GHz SSID.',
      'Mesh extenders should connect after the ONT shows NET/Internet online.',
    ],
    wifiSteps: OPTIXSTAR_WIFI_SSID_STEPS,
    wifiTips: OPTIXSTAR_WIFI_SSID_TIPS,
  },
  {
    id: '8145x6-10',
    model: 'Huawei OptiXstar EG8145X6-10',
    blurb: 'Wi‑Fi 6 dual-band ONT (firmware R022 / R024) — same WLAN menu as EG8041X6-10.',
    steps: [
      'Check fiber seating and LOS LED first (same rules as other Huawei ONTs).',
      'Wait for PON steady + NET/Internet LED before testing speed.',
      'Power-cycle 30 seconds if the unit was moved or after a building outage.',
      'Reconnect Wi‑Fi using the label SSID/password; toggle airplane mode on the phone to force a fresh association.',
      'Admin page (if enabled): http://192.168.100.1 — Status → WAN should show Connected.',
      'If PPPoE/auth fails in the UI, do not change WAN settings — report to support with a screenshot.',
    ],
    tips: [
      'Factory reset is last resort and requires ISP re-provisioning.',
      'Place the ONT centrally; thick walls cut 5 GHz range quickly.',
    ],
    wifiSteps: OPTIXSTAR_WIFI_SSID_STEPS,
    wifiTips: OPTIXSTAR_WIFI_SSID_TIPS,
  },
];
