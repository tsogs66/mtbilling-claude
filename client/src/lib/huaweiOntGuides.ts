/** Self-help reconnect guides for common Huawei ONTs used by PANORTH. */

export type OntGuide = {
  id: string;
  model: string;
  blurb: string;
  steps: string[];
  tips: string[];
};

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
  },
  {
    id: '8041x6-10',
    model: 'Huawei OptiXstar EG8041X6-10',
    blurb: 'Wi‑Fi 6 ONT often used for higher-speed plans.',
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
  },
  {
    id: '8145x6-10',
    model: 'Huawei OptiXstar EG8145X6-10',
    blurb: 'Wi‑Fi 6 dual-band ONT similar to 8145V5 with newer radio.',
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
  },
];
