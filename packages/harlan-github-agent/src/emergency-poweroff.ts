/** Queue a normal systemd shutdown after the HTTP response can leave the broker. */
export function queueEmergencyPowerOff(run: (file: string, args: string[]) => void) {
  run('/usr/bin/systemd-run', [
    '--quiet',
    '--unit=hogwild-phone-poweroff',
    '--on-active=5s',
    '--timer-property=AccuracySec=1s',
    '/usr/bin/systemctl',
    'poweroff',
  ])
}
