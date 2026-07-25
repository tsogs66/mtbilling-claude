# =============================================================================
# MT-Billing — OLT access: MikroTik → ER7206 → SG3428X (VLAN 50) → OLT
# =============================================================================
# Topology:
#   [MT-Billing] 20.0.0.x  →  [MikroTik 20.0.0.1]
#         →  [ER7206 20.0.0.5]  LAN5  →  [SG3428X VLAN 50]  →  [OLT 50.0.0.100]
#
# Gateway for OLT subnet (50.0.0.1) should be on ER7206 LAN5 OR SG3428X L3 SVI —
# pick ONE device as 50.0.0.1 (recommended: ER7206 LAN5).
#
# /import file-name=mikrotik-olt-access.rsc
# =============================================================================

:local er7206Gw "20.0.0.5"
:local oltHost "50.0.0.100"
:local oltNet "50.0.0.0/24"
:local mgmtNet "20.0.0.0/24"
:local tag "mt-billing-olt"

:if ([:len [/ip route find where comment=$tag and dst-address=$oltNet]] = 0) do={
  /ip route add dst-address=$oltNet gateway=$er7206Gw comment=$tag
}

:if ([:len [/ip firewall filter find where comment=($tag . "-snmp")]] = 0) do={
  /ip firewall filter add chain=forward action=accept protocol=udp src-address=$mgmtNet dst-address=$oltHost dst-port=161 comment=($tag . "-snmp") place-before=0
}

:if ([:len [/ip firewall filter find where comment=($tag . "-tcp")]] = 0) do={
  /ip firewall filter add chain=forward action=accept protocol=tcp src-address=$mgmtNet dst-address=$oltHost dst-port=22,23,80,443,8080 comment=($tag . "-tcp") place-before=0
}

:if ([:len [/ip firewall filter find where comment=($tag . "-all")]] = 0) do={
  /ip firewall filter add chain=forward action=accept src-address=$mgmtNet dst-address=$oltNet comment=($tag . "-all") place-before=0
}

:if ([:len [/ip firewall filter find where comment=($tag . "-return")]] = 0) do={
  /ip firewall filter add chain=forward action=accept connection-state=established,related comment=($tag . "-return") place-before=0
}

:if ([:len [/ip firewall filter find where comment=($tag . "-gw")]] = 0) do={
  /ip firewall filter add chain=forward action=accept dst-address=$er7206Gw comment=($tag . "-gw") place-before=0
}

:log info ("MT-Billing: ping OLT from MikroTik: /ping " . $oltHost)

# --- MikroTik terminal paste (literal IPs) -----------------------------------
# /ip route add dst-address=50.0.0.0/24 gateway=20.0.0.5 comment=mt-billing-olt
# /ip firewall filter add chain=forward action=accept protocol=udp src-address=20.0.0.0/24 dst-address=50.0.0.100 dst-port=161 comment=mt-billing-olt-snmp place-before=0
# /ip firewall filter add chain=forward action=accept protocol=tcp src-address=20.0.0.0/24 dst-address=50.0.0.100 dst-port=22,23,80,443,8080 comment=mt-billing-olt-tcp place-before=0
# /ip firewall filter add chain=forward action=accept src-address=20.0.0.0/24 dst-address=50.0.0.0/24 comment=mt-billing-olt-all place-before=0
#
# --- SG3428X (VLAN 50) -------------------------------------------------------
# 1) L2 → L2 Features → VLAN → 802.1Q VLAN → create VLAN ID 50
# 2) Add OLT switch port(s) to VLAN 50 UNTAGGED
# 3) Port to ER7206 LAN5: VLAN 50 UNTAGGED (access) OR TAGGED (trunk) — match ER7206
#
# --- ER7206 LAN5 -------------------------------------------------------------
# Option A (simple access): LAN5 = 50.0.0.1/24, switch port = access VLAN 50
# Option B (trunk): ER7206 VLAN sub-interface 50.0.0.1/24 on LAN5 tagged VLAN 50
#
# OLT: IP 50.0.0.100, mask 255.255.255.0, gateway 50.0.0.1, SNMP on
# MT-Billing OLT host: 50.0.0.100
# =============================================================================
